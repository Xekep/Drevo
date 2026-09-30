import { useEffect, useMemo, useRef } from "react";
import { useStoreApi } from "@xyflow/react";
import { safeUrl, type Person } from "../../domain";
import { mediaPreview } from "../../domain/media-preview.ts";
import type { PersonNodeType } from "./person-node";

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
  context.drawImage(image, (TINY_SIZE - width) / 2, (TINY_SIZE - height) / 2, width, height);
  return canvas;
}

export function DistantPortraits({
  people,
  nodes,
  width,
  height,
  growing,
  growthStarted,
  growthDelays,
}: {
  people: readonly Person[];
  nodes: readonly PersonNodeType[];
  width: number;
  height: number;
  growing: boolean;
  growthStarted: boolean;
  growthDelays: ReadonlyMap<string, number>;
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
    const growthEnd = Math.max(0, ...growthDelays.values()) + 400;
    let frame = 0;
    let settleTimer = 0;
    let base = store.getState().transform;
    let handingOff = false;
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
        const opacity = Math.min(1, Math.max(0, (elapsed - delay) / 100));
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
  }, [store, nodes, width, height, growing, growthStarted, growthDelays]);

  return <div className="tree-distant-portrait-clip" aria-hidden="true">
    <canvas
      ref={canvasRef}
      className="tree-distant-portraits"
      width={Math.ceil(width) + OVERSCAN * 2}
      height={Math.ceil(height) + OVERSCAN * 2}
    />
  </div>;
}
