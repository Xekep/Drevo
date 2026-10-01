import { useEffect, useMemo, useRef } from "react";
import { useStoreApi } from "@xyflow/react";
import { safeUrl, type Person } from "../../domain";
import { fullName } from "../../domain/dates.ts";
import { mediaPreview } from "../../domain/media-preview.ts";
import { roundedRoute } from "../../domain/edge-routing.ts";
import type { HouseholdNodeType } from "./household-node.tsx";
import type { PersonNodeType } from "./person-node";
import type { RelationshipEdgeType } from "./relationship-edge.tsx";
import { treeGrowthDuration, type TreeGrowthSchedule } from "./tree-growth.ts";

const PORTRAIT_SIZE = 132;
const PORTRAIT_TOP = 4;
const TINY_SIZE = 48;
const MAX_PARALLEL_LOADS = 12;
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

export function DistantPortraits({
  people,
  nodes,
  households = [],
  edges = [],
  fullScene = false,
  width,
  height,
  growing,
  growthStarted,
  growthDelays,
}: {
  people: readonly Person[];
  nodes: readonly PersonNodeType[];
  households?: readonly HouseholdNodeType[];
  edges?: readonly RelationshipEdgeType[];
  fullScene?: boolean;
  width: number;
  height: number;
  growing: boolean;
  growthStarted: boolean;
  growthDelays: TreeGrowthSchedule;
}) {
  const store = useStoreApi();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previews = useRef(new Map<string, HTMLCanvasElement>());
  const pending = useRef(new Map<string, Promise<void>>());
  const requestDraw = useRef<() => void>(() => {});
  const growthStartedAt = useRef<number | null>(null);
  const urls = useMemo(() => [...new Set(people.flatMap((person) => {
    const url = tinyPortraitUrl(person.photo);
    return url ? [url] : [];
  }))], [people]);

  useEffect(() => {
    let active = true;
    let next = 0;
    const load = (url: string) => {
      if (previews.current.has(url)) return Promise.resolve();
      const existing = pending.current.get(url);
      if (existing) return existing;
      const image = new Image();
      image.src = url;
      const task = image.decode().then(() => {
        previews.current.set(url, circularPreview(image));
        requestDraw.current();
      }).catch(() => {}).finally(() => pending.current.delete(url));
      pending.current.set(url, task);
      return task;
    };
    const worker = async () => {
      while (active && next < urls.length) await load(urls[next++]);
    };
    for (let index = 0; index < Math.min(MAX_PARALLEL_LOADS, urls.length); index++)
      void worker();
    return () => { active = false; };
  }, [urls]);

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
    const paths = fullScene ? edges.map((edge) => {
      const points = edge.data?.route?.points;
      const path = edge.data?.path || (points?.length ? roundedRoute(points).path : null);
      const bounds = points?.reduce((box, point) => ({
        left: Math.min(box.left, point.x), top: Math.min(box.top, point.y),
        right: Math.max(box.right, point.x), bottom: Math.max(box.bottom, point.y),
      }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
      return { edge, bounds, path: path ? new Path2D(path) : null,
        dash: String(edge.style?.strokeDasharray || "")
          .split(/[ ,]+/).map(Number).filter((value) => value > 0) };
    }) : [];
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
        for (const { edge, bounds, path, dash } of paths) {
          if (!path || !bounds || !visible(bounds.left, bounds.top,
            bounds.right - bounds.left, bounds.bottom - bounds.top)) continue;
          context.strokeStyle = String(edge.style?.stroke || "#58775a");
          context.lineWidth = Math.max(Number(edge.style?.strokeWidth) || 1.6, 0.4 / zoom);
          context.setLineDash(dash);
          context.stroke(path);
        }
        context.setLineDash([]);
        for (const node of nodes) {
          const x = node.position.x, y = node.position.y;
          const cardWidth = node.width || PORTRAIT_SIZE + 16;
          const cardHeight = node.height || PORTRAIT_SIZE + 60;
          if (!visible(x, y, cardWidth, cardHeight)) continue;
          const person = node.data.person;
          const delay = growthDelays.get(person.id) || 0;
          const opacity = growing ? Math.min(1, Math.max(0, (elapsed - delay) / growthDelays.revealMs)) : 1;
          if (opacity <= 0) continue;
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
            context.fillStyle = person.sex === "f" ? "#e9d9cd" : "#d9e2d8";
            context.beginPath();
            context.arc(centerX, centerY, PORTRAIT_SIZE / 2, 0, Math.PI * 2);
            context.fill();
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

  return <div className="tree-distant-portrait-clip" aria-hidden="true">
    <canvas
      ref={canvasRef}
      className="tree-distant-portraits"
      width={Math.ceil(width) + OVERSCAN * 2}
      height={Math.ceil(height) + OVERSCAN * 2}
    />
  </div>;
}
