import { useEffect, useMemo, useRef } from "react";
import { useStoreApi } from "@xyflow/react";
import { resolvedSex, safeUrl } from "../../domain";
import { fullName } from "../../domain/dates.ts";
import { mediaPreview } from "../../domain/media-preview.ts";
import { mayRetryPortrait, portraitLoadTimeoutMs, portraitRetryDelays, retryPortraitUrl, waitForPortraitRetry } from "../portrait-retry.ts";
import { roundedRoute, Spatial } from "../../domain/edge-routing.ts";
import type { HouseholdNodeType } from "./household-node.tsx";
import type { PersonNodeType } from "./person-node";
import type { RelationshipEdgeType } from "./relationship-edge.tsx";
import { treeGrowthDuration, type TreeGrowthSchedule } from "./tree-growth.ts";
import { gpuRoute } from "./gpu-route.ts";

const PORTRAIT_SIZE = 132;
const PORTRAIT_TOP = 4;
const TINY_SIZE = 48;
const MAX_PARALLEL_LOADS = 12;
const RETAINED_PREVIEWS = 1024;
const OVERSCAN = 256;

function tinyPortraitUrl(photo?: string) {
  if (!photo || !(
    /^\/media\/[a-zA-Z0-9-]+\.(jpg|png|webp)$/.test(photo) ||
    /^\/api\/shared\/[A-Za-z0-9_-]{43}\/portrait\/[^/?#]+$/.test(photo)
  )) return undefined;
  return mediaPreview(safeUrl(photo), "tiny");
}

function circularPreview(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = TINY_SIZE;
  canvas.height = TINY_SIZE;
  const context = canvas.getContext("2d")!;
  const scale = Math.max(TINY_SIZE / image.naturalWidth, TINY_SIZE / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.beginPath();
  context.arc(TINY_SIZE / 2, TINY_SIZE / 2, TINY_SIZE / 2, 0, Math.PI * 2);
  context.clip();
  context.filter = "grayscale(1)";
  context.drawImage(image, (TINY_SIZE - width) / 2, (TINY_SIZE - height) / 2, width, height);
  return canvas;
}

// Three reusable tiny cameos replace flat circles without a per-person SVG or
// image request. The two shapes match the compact DOM placeholder.
function placeholderPreview(sex: "f" | "m" | "u") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TINY_SIZE;
  const context = canvas.getContext("2d")!;
  context.scale(TINY_SIZE / 80, TINY_SIZE / 80);
  context.beginPath();
  context.arc(40, 40, 40, 0, Math.PI * 2);
  context.clip();
  const colors = sex === "f" ? ["#fff9ee", "#ede4d7", "#a58c78"]
    : sex === "m" ? ["#fafbf3", "#e4ead9", "#71856b"]
      : ["#fafbf3", "#e4ead9", "#8a927f"];
  const background = context.createRadialGradient(32, 20, 0, 32, 20, 80);
  background.addColorStop(0, colors[0]);
  background.addColorStop(1, colors[1]);
  context.fillStyle = background;
  context.fillRect(0, 0, 80, 80);
  context.fillStyle = colors[2];
  context.globalAlpha = 0.23;
  context.fill(new Path2D("M18 69c1-14 9-22 22-22s21 8 22 22"));
  context.globalAlpha = 0.35;
  context.beginPath();
  context.ellipse(40, 30, 12, 15, 0, 0, Math.PI * 2);
  context.fill();
  return canvas;
}

export function DistantPortraits({
  nodes,
  households = [],
  edges = [],
  fullScene = false,
  width,
  height,
  growing,
  growthStarted,
  growthDelays,
  cameraReady = true,
}: {
  nodes: readonly PersonNodeType[];
  households?: readonly HouseholdNodeType[];
  edges?: readonly RelationshipEdgeType[];
  fullScene?: boolean;
  width: number;
  height: number;
  growing: boolean;
  growthStarted: boolean;
  growthDelays: TreeGrowthSchedule;
  cameraReady?: boolean;
}) {
  const store = useStoreApi();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previews = useRef(new Map<string, HTMLCanvasElement>());
  const placeholders = useRef<Partial<Record<"f" | "m" | "u", HTMLCanvasElement>>>({});
  const requestDraw = useRef<() => void>(() => {});
  const growthStartedAt = useRef<number | null>(null);
  const pathCache = useRef(new Map<string, {
    path: Path2D;
    segments: ReturnType<typeof gpuRoute> | null;
    length: number;
  }>());
  // Selection and detail hydration create fresh nodes. Only image URLs and
  // geometry invalidate the loader's spatial index and running requests.
  const portraitKey = useMemo(() => JSON.stringify(nodes.flatMap((node) => {
    const url = tinyPortraitUrl(node.data.person.photo);
    return url ? [[url, node.position.x + (node.width || PORTRAIT_SIZE + 16) / 2 - PORTRAIT_SIZE / 2,
      node.position.y + PORTRAIT_TOP]] : [];
  })), [nodes]);
  const portraitBounds = useMemo(() => {
    const bounds = (JSON.parse(portraitKey) as [string, number, number][]).map(([url, x, y]) => ({
      url, left: x, top: y, right: x + PORTRAIT_SIZE, bottom: y + PORTRAIT_SIZE,
    }));
    const index = new Spatial<(typeof bounds)[number]>();
    for (const item of bounds) index.add(item);
    return { bounds, index };
  }, [portraitKey]);

  useEffect(() => {
    let active = true;
    let frame = 0;
    let wanted: string[] = [];
    let nextWanted = 0;
    let wantedSet = new Set<string>();
    const loading = new Map<string, HTMLImageElement>();
    const loadDeadlines = new Map<string, number>();
    const failed = new Map<string, number>();
    const retries = new Map<string, number>();
    const recovering = new Map<string, AbortController>();
    const clearLoadDeadline = (url: string) => {
      const deadline = loadDeadlines.get(url);
      if (deadline !== undefined) window.clearTimeout(deadline);
      loadDeadlines.delete(url);
    };
    const available = new Set(portraitBounds.bounds.map(({ url }) => url));
    for (const url of previews.current.keys())
      if (!available.has(url)) previews.current.delete(url);
    const prune = () => {
      // Keep every visible face, plus a bounded history for return gestures.
      // The budget grows only if the viewport itself contains more faces.
      const limit = Math.max(RETAINED_PREVIEWS, wantedSet.size);
      for (const url of previews.current.keys()) {
        if (previews.current.size <= limit) break;
        if (!wantedSet.has(url)) previews.current.delete(url);
      }
    };
    const pump = () => {
      if (!active) return;
      while (nextWanted < wanted.length && loading.size + recovering.size < MAX_PARALLEL_LOADS) {
        const url = wanted[nextWanted++];
        if (previews.current.has(url) || loading.has(url) || recovering.has(url) ||
            Date.now() - (failed.get(url) ?? -Infinity) < 30_000) continue;
        const image = new Image();
        loading.set(url, image);
        const finish = () => {
          if (loading.get(url) !== image) return false;
          loading.delete(url);
          clearLoadDeadline(url);
          return true;
        };
        const fail = () => {
          if (!active || !finish()) return;
          const attempt = retries.get(url) || 0;
          failed.set(url, attempt >= portraitRetryDelays.length ? Infinity : Date.now());
          if (attempt < portraitRetryDelays.length) {
            const controller = new AbortController();
            recovering.set(url, controller);
            void (async () => {
              await waitForPortraitRetry(portraitRetryDelays[attempt], controller.signal);
              if (controller.signal.aborted) return;
              const retry = await mayRetryPortrait(url, controller.signal);
              if (controller.signal.aborted || !active || !wantedSet.has(url)) return;
              if (retry) {
                retries.set(url, attempt + 1);
                failed.delete(url);
                nextWanted = 0;
              } else failed.set(url, Infinity);
            })().finally(() => {
              if (recovering.get(url) === controller) {
                recovering.delete(url);
                pump();
              }
            });
          }
          pump();
        };
        loadDeadlines.set(url, window.setTimeout(() => {
          if (!active || loading.get(url) !== image) return;
          image.src = "";
          fail();
        }, portraitLoadTimeoutMs));
        image.src = retryPortraitUrl(url, retries.get(url) || 0);
        void image.decode().then(() => {
          // Aborted decodes can resolve late. Never create a detached canvas
          // after a camera change, projection change or GPU handoff.
          if (!active || loading.get(url) !== image) return;
          if (!wantedSet.has(url)) {
            finish();
            pump();
            return;
          }
          try {
            previews.current.set(url, circularPreview(image));
          } catch {
            fail();
            return;
          }
          finish();
          failed.delete(url);
          retries.delete(url);
          prune();
          requestDraw.current();
          pump();
        }, fail);
      }
    };
    const refresh = () => {
      frame = 0;
      const [tx, ty, zoom] = store.getState().transform;
      // During the intro, warm the current camera vicinity without exposing
      // a completed layer. A settled near view already has native portraits.
      const visible = cameraReady && width > 0 && height > 0 && (zoom < 0.18 || growing)
        ? portraitBounds.index.query({
          left: (-tx - OVERSCAN) / zoom, top: (-ty - OVERSCAN) / zoom,
          right: (width - tx + OVERSCAN) / zoom, bottom: (height - ty + OVERSCAN) / zoom,
        }) : [];
      const cx = (width / 2 - tx) / zoom, cy = (height / 2 - ty) / zoom;
      visible.sort((a, b) => Math.hypot(a.left - cx, a.top - cy) - Math.hypot(b.left - cx, b.top - cy));
      wanted = [...new Set(visible.map(({ url }) => url))];
      nextWanted = 0;
      wantedSet = new Set(wanted);
      for (const [url, image] of loading)
        if (!wantedSet.has(url)) {
          clearLoadDeadline(url);
          loading.delete(url);
          image.src = "";
        }
      for (const [url, controller] of recovering)
        if (!wantedSet.has(url)) {
          controller.abort();
          recovering.delete(url);
        }
      for (const url of retries.keys())
        if (!wantedSet.has(url)) retries.delete(url);
      for (const url of failed.keys())
        if (!wantedSet.has(url)) failed.delete(url);
      for (const url of wanted) {
        const preview = previews.current.get(url);
        if (preview) {
          previews.current.delete(url);
          previews.current.set(url, preview);
        }
      }
      prune();
      pump();
    };
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.transform !== previous.transform && !frame)
        frame = requestAnimationFrame(refresh);
    });
    refresh();
    return () => {
      active = false;
      unsubscribe();
      cancelAnimationFrame(frame);
      for (const image of loading.values()) image.src = "";
      for (const deadline of loadDeadlines.values()) window.clearTimeout(deadline);
      loadDeadlines.clear();
      loading.clear();
      for (const controller of recovering.values()) controller.abort();
      recovering.clear();
    };
  }, [store, portraitBounds, width, height, growing, cameraReady]);

  useEffect(() => {
    if (!growing || !growthStarted) growthStartedAt.current = null;
    else if (growthStartedAt.current === null) growthStartedAt.current = performance.now();
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !width || !height) return;
    const growthEnd = treeGrowthDuration(Math.max(0, ...growthDelays.values()), growthDelays);
    let frame = 0;
    let settleTimer = 0;
    let base = store.getState().transform;
    let handingOff = false;
    const activePaths = new Set<string>();
    const paths = fullScene ? edges.map((edge) => {
      const points = edge.data?.route?.points;
      const path = edge.data?.path || (points?.length ? roundedRoute(points).path : null);
      const bounds = points?.reduce((box, point) => ({
        left: Math.min(box.left, point.x), top: Math.min(box.top, point.y),
        right: Math.max(box.right, point.x), bottom: Math.max(box.bottom, point.y),
      }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
      let compiled = path ? pathCache.current.get(path) : undefined;
      if (path) {
        activePaths.add(path);
        if (!compiled) {
          compiled = { path: new Path2D(path), segments: null, length: 0 };
          pathCache.current.set(path, compiled);
        }
        if (growing && !compiled.segments) {
          compiled.segments = gpuRoute(path);
          compiled.length = compiled.segments.reduce((total, segment) =>
            total + Math.hypot(segment.bx - segment.ax, segment.by - segment.ay), 0);
        } else if (!growing) {
          compiled.segments = null;
          compiled.length = 0;
        }
      }
      const segments = growing ? compiled?.segments || [] : [];
      const length = growing ? compiled?.length || 0 : 0;
      const style = edge.style as (typeof edge.style & {
        "--tree-growth-delay"?: string;
        "--tree-growth-edge-duration"?: string;
      });
      return { edge, bounds, path: compiled?.path || null, segments, length,
        starts: Number.parseFloat(style?.["--tree-growth-delay"] || "0"),
        duration: Number.parseFloat(style?.["--tree-growth-edge-duration"] || String(growthDelays.edgeMs)),
        dash: String(edge.style?.strokeDasharray || "")
          .split(/[ ,]+/).map(Number).filter((value) => value > 0) };
    }) : [];
    // Bound the cache to this projection; old branches/grants need no paths.
    for (const key of pathCache.current.keys())
      if (!activePaths.has(key)) pathCache.current.delete(key);
    const normalPortraitsReady = () => {
      const root = canvas.closest(".tree-canvas");
      if (!root?.querySelector(".flow-person:not(.is-distant)")) return false;
      const images = root.querySelectorAll<HTMLImageElement>(
        ".flow-person:not(.is-distant) .person-avatar img",
      );
      return [...images].every((image) => image.complete);
    };
    const transformTo = ([x, y, zoom]: number[]) => {
      const scale = zoom / base[2];
      const dx = x - base[0] * scale + OVERSCAN * (1 - scale);
      const dy = y - base[1] * scale + OVERSCAN * (1 - scale);
      canvas.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${dx}, ${dy})`;
    };
    const draw = () => {
      frame = 0;
      window.clearTimeout(settleTimer);
      const transform = store.getState().transform;
      // Keep the canvas mounted and previews loading for the shared intro
      // start, but do not paint a completed scene while that start is pending.
      if (growing && !growthStarted) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.visibility = "hidden";
        canvas.dataset.portraitCount = "0";
        return;
      }
      if (transform[2] >= 0.18 && handingOff) {
        if (!normalPortraitsReady()) {
          settleTimer = window.setTimeout(schedule, 60);
          return;
        }
        handingOff = false;
        canvas.style.visibility = "hidden";
        base = transform;
        return;
      }
      base = transform;
      canvas.style.transform = "";
      context.clearRect(0, 0, canvas.width, canvas.height);
      const [tx, ty, zoom] = base;
      canvas.style.visibility = zoom >= 0.18 ? "hidden" : "visible";
      if (zoom >= 0.18) return;
      const elapsed = growthStartedAt.current === null
        ? Infinity : performance.now() - growthStartedAt.current;
      let painted = 0;
      if (fullScene) {
        const left = (-tx - OVERSCAN) / zoom;
        const top = (-ty - OVERSCAN) / zoom;
        const right = (width - tx + OVERSCAN) / zoom;
        const bottom = (height - ty + OVERSCAN) / zoom;
        const visible = (x: number, y: number, w: number, h: number) =>
          x + w >= left && y + h >= top && x <= right && y <= bottom;
        context.save();
        context.translate(tx + OVERSCAN, ty + OVERSCAN);
        context.scale(zoom, zoom);
        for (const group of households) {
          if (!group.data.label || !visible(group.position.x, group.position.y,
            group.width || 0, group.height || 0)) continue;
          context.fillStyle = "#eaf0e22b";
          context.strokeStyle = "#dfe6d7";
          context.lineWidth = 1;
          context.beginPath();
          context.roundRect(group.position.x, group.position.y,
            group.width || 0, group.height || 0, 14);
          context.fill();
          context.stroke();
        }
        let introPartialEdges = 0;
        let introVisibleEdges = 0;
        for (const { edge, bounds, path, segments, length, starts, duration, dash } of paths) {
          if (!path || !bounds || !visible(bounds.left, bounds.top,
            bounds.right - bounds.left, bounds.bottom - bounds.top)) continue;
          const progress = growing ? Math.min(1, Math.max(0,
            (elapsed - starts) / Math.max(1, duration))) : 1;
          if (progress <= 0) continue;
          introVisibleEdges++;
          if (progress < 1) introPartialEdges++;
          context.strokeStyle = String(edge.style?.stroke || "#58775a");
          context.lineWidth = Math.max(Number(edge.style?.strokeWidth) || 1.6, 0.4 / zoom);
          context.setLineDash(dash);
          if (growing && progress < 1) {
            let remaining = length * progress;
            context.beginPath();
            for (const segment of segments) {
              if (remaining <= 0) break;
              const segmentLength = Math.hypot(segment.bx - segment.ax, segment.by - segment.ay);
              const fraction = Math.min(1, remaining / segmentLength);
              if (!segment.distance) context.moveTo(segment.ax, segment.ay);
              context.lineTo(segment.ax + (segment.bx - segment.ax) * fraction,
                segment.ay + (segment.by - segment.ay) * fraction);
              remaining -= segmentLength;
            }
            context.stroke();
          } else context.stroke(path);
        }
        context.setLineDash([]);
        if (growing) {
          canvas.dataset.introPartialEdges = String(introPartialEdges);
          canvas.dataset.introVisibleEdges = String(introVisibleEdges);
        }
        let introVisibleNodes = 0;
        for (const node of nodes) {
          const x = node.position.x, y = node.position.y;
          const cardWidth = node.width || PORTRAIT_SIZE + 16;
          const cardHeight = node.height || PORTRAIT_SIZE + 60;
          if (!visible(x, y, cardWidth, cardHeight)) continue;
          const person = node.data.person;
          const delay = growthDelays.get(person.id) || 0;
          const opacity = growing ? Math.min(1, Math.max(0, (elapsed - delay) / growthDelays.revealMs)) : 1;
          if (opacity <= 0) continue;
          introVisibleNodes++;
          context.globalAlpha = node.data.dimmed ? opacity * 0.28 : opacity;
          const centerX = x + cardWidth / 2;
          const centerY = y + PORTRAIT_TOP + PORTRAIT_SIZE / 2;
          const url = tinyPortraitUrl(person.photo);
          const preview = url ? previews.current.get(url) : undefined;
          if (preview) {
            context.drawImage(preview, centerX - PORTRAIT_SIZE / 2,
              y + PORTRAIT_TOP, PORTRAIT_SIZE, PORTRAIT_SIZE);
            painted++;
          } else {
            const sex = resolvedSex(person);
            const placeholder = placeholders.current[sex] ||= placeholderPreview(sex);
            context.drawImage(placeholder, centerX - PORTRAIT_SIZE / 2,
              y + PORTRAIT_TOP, PORTRAIT_SIZE, PORTRAIT_SIZE);
          }
          context.strokeStyle = person.needsReview ? "#d77b18"
            : node.selected || node.data.spotlit ? "#5c8650" : "#fffefa";
          context.lineWidth = person.needsReview || node.selected || node.data.spotlit ? 6 : 3;
          context.beginPath();
          context.arc(centerX, centerY, PORTRAIT_SIZE / 2 - 2, 0, Math.PI * 2);
          context.stroke();
          context.fillStyle = "#253a2c";
          context.font = "600 29px Georgia, serif";
          context.textAlign = "center";
          context.textBaseline = "top";
          const name = fullName(person);
          const maxWidth = Math.max(20, cardWidth - 8);
          context.fillText(name, centerX, y + PORTRAIT_TOP + PORTRAIT_SIZE + 10, maxWidth);
        }
        context.restore();
        context.globalAlpha = 1;
        canvas.dataset.sceneNodes = String(nodes.length);
        canvas.dataset.sceneEdges = String(edges.length);
        if (growing) canvas.dataset.introVisibleNodes = String(introVisibleNodes);
      } else {
        for (const node of nodes) {
          const url = tinyPortraitUrl(node.data.person.photo);
          const preview = url ? previews.current.get(url) : undefined;
          if (!preview) continue;
          const size = PORTRAIT_SIZE * zoom;
          const x = tx + (node.position.x + (node.width || 0) / 2) * zoom - size / 2;
          const y = ty + (node.position.y + PORTRAIT_TOP) * zoom;
          if (x + size < -OVERSCAN || y + size < -OVERSCAN ||
              x > width + OVERSCAN || y > height + OVERSCAN) continue;
          const delay = growing ? growthDelays.get(node.data.person.id) || 0 : 0;
          const opacity = Math.min(1, Math.max(0, (elapsed - delay) / growthDelays.revealMs));
          if (opacity <= 0) continue;
          context.globalAlpha = opacity;
          context.drawImage(preview, x + OVERSCAN, y + OVERSCAN, size, size);
          if (node.data.person.needsReview) {
            context.beginPath();
            context.arc(x + OVERSCAN + size / 2, y + OVERSCAN + size / 2,
              Math.max(0, size / 2 - 1), 0, Math.PI * 2);
            context.strokeStyle = "#d77b18";
            context.lineWidth = Math.max(2, size * 0.05);
            context.stroke();
          }
          painted++;
        }
      }
      context.globalAlpha = 1;
      if (canvas.dataset.portraitCount !== String(painted))
        canvas.dataset.portraitCount = String(painted);
      if (growthStartedAt.current !== null && elapsed < growthEnd) schedule();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    requestDraw.current = schedule;
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.transform === previous.transform) return;
      if (growing && !growthStarted) return;
      if (growthStartedAt.current !== null) {
        schedule();
        return;
      }
      const [x, y, zoom] = state.transform;
      if (zoom >= 0.18) {
        if (base[2] < 0.18 && Number(canvas.dataset.portraitCount) > 0) {
          handingOff = true;
          canvas.style.visibility = "visible";
          transformTo(state.transform);
          window.clearTimeout(settleTimer);
          settleTimer = window.setTimeout(schedule, 60);
        } else {
          canvas.style.visibility = "hidden";
          base = state.transform;
        }
        return;
      }
      handingOff = false;
      canvas.style.visibility = "visible";
      if (base[2] >= 0.18) {
        schedule();
        return;
      }
      transformTo([x, y, zoom]);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(schedule, 120);
    });
    schedule();
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      requestDraw.current = () => {};
    };
  }, [store, nodes, households, edges, fullScene, width, height, growing, growthStarted, growthDelays]);

  return <div className="tree-distant-portrait-clip" aria-hidden="true"
    style={{ opacity: growing && !growthStarted ? 0 : undefined }}>
    <canvas
      ref={canvasRef}
      className="tree-distant-portraits"
      width={Math.ceil(width) + OVERSCAN * 2}
      height={Math.ceil(height) + OVERSCAN * 2}
    />
  </div>;
}
