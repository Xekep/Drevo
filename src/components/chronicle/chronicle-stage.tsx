import { useEffect, useRef, useState } from "react";
import { mediaPreview } from "../../domain/media-preview";
import { photoLabel } from "../../domain/photo-metadata";
import type { ArchivePhoto } from "../../domain/types";
import { createLiquidGlassRenderer } from "./liquid-glass-renderer";

export function ChronicleStage({
  photo,
  effect,
  reduced,
  onBusy,
  onShown,
  onError,
  onFallback,
  onPrevious,
  onNext,
}: {
  photo: ArchivePhoto;
  effect: "glass" | "fade";
  reduced: boolean;
  onBusy: (value: boolean) => void;
  onShown: (id: string) => void;
  onError: () => void;
  onFallback: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    image = useRef<HTMLImageElement>(null);
  const incoming = useRef<HTMLImageElement>(null);
  const renderer = useRef<ReturnType<typeof createLiquidGlassRenderer> | null>(
    null,
  );
  const current = useRef<{ id: string; image: HTMLImageElement } | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestKey = JSON.stringify([photo.id, photo.url, attempt]);
  const [media, setMedia] = useState({ key: "", state: "loading" });
  const status = media.key === requestKey ? media.state : "loading";
  useEffect(
    () => () => {
      renderer.current?.dispose(true);
      renderer.current = null;
    },
    [],
  );
  useEffect(() => {
    let cancelled = false,
      frame = 0,
      started = 0,
      previousFrame = 0,
      slowFrames = 0,
      sampled = 0;
    let target: HTMLImageElement | null = new Image();
    const targetImage = target;
    const surface = canvas.current!,
      settled = image.current!,
      overlay = incoming.current!;
    onBusy(true);
    const timeout = window.setTimeout(fail, 20_000);
    function fail() {
      if (cancelled) return;
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      setMedia({ key: requestKey, state: "error" });
      surface.style.opacity = "0";
      overlay.style.opacity = "0";
      onBusy(false);
      onError();
    }
    function finish() {
      if (cancelled || !target) return;
      settled.src = target.src;
      settled.alt = photoLabel(photo);
      current.current = { id: photo.id, image: target };
      surface.style.opacity = "0";
      overlay.style.opacity = "0";
      onShown(photo.id);
      onBusy(false);
    }
    let glass = false;
    function lost(event: Event) {
      event.preventDefault();
      if (cancelled) return;
      glass = false;
      renderer.current?.dispose();
      renderer.current = null;
      onFallback();
      cancelAnimationFrame(frame);
      if (target?.complete && target.naturalWidth) finish();
    }
    surface.addEventListener("webglcontextlost", lost);
    target.onload = () => {
      if (cancelled || !target) return;
      clearTimeout(timeout);
      setMedia({ key: requestKey, state: "ready" });
      if (!current.current || reduced || current.current.id === photo.id) {
        finish();
        return;
      }
      overlay.src = target.src;
      if (effect === "glass") {
        try {
          renderer.current ??= createLiquidGlassRenderer(surface);
          renderer.current.prepare(current.current.image, target);
          renderer.current.render(0);
          surface.style.opacity = "1";
          glass = true;
        } catch {
          renderer.current?.dispose();
          renderer.current = null;
          onFallback();
        }
      }
      const duration = glass ? 2500 : 450;
      const tick = (now: number) => {
        if (cancelled) return;
        if (!started) started = now;
        if (previousFrame && glass && sampled < 30) {
          sampled++;
          if (now - previousFrame > 45) slowFrames++;
        }
        previousFrame = now;
        const t = Math.min(1, (now - started) / duration);
        // GSAP power2.inOut: the same cubic timing as the reference.
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        try {
          if (glass) renderer.current!.render(eased);
          else overlay.style.opacity = String(eased);
        } catch {
          onFallback();
          finish();
          return;
        }
        if (glass && sampled >= 12 && slowFrames >= 8) {
          onFallback();
          finish();
          return;
        }
        if (t >= 1) {
          finish();
          return;
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    target.onerror = fail;
    target.src = mediaPreview(photo.url, "display") || "";
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      surface.removeEventListener("webglcontextlost", lost);
      surface.style.opacity = "0";
      overlay.style.opacity = "0";
      targetImage.onload = targetImage.onerror = null;
      if (!targetImage.complete) targetImage.src = "";
      target = null;
    };
  }, [
    photo.id,
    photo.url,
    attempt,
    effect,
    reduced,
    onBusy,
    onShown,
    onError,
    onFallback,
    photo,
    requestKey,
  ]);
  return (
    <div
      className="chronicle-stage"
      onTouchStart={(event) => {
        touch.current =
          event.touches.length === 1
            ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
            : null;
      }}
      onTouchEnd={(event) => {
        const start = touch.current,
          end = event.changedTouches[0];
        touch.current = null;
        if (
          start &&
          end &&
          Math.abs(end.clientX - start.x) > 50 &&
          Math.abs(end.clientY - start.y) < 80
        ) {
          if (end.clientX < start.x) onNext();
          else onPrevious();
        }
      }}
    >
      {/* No shader, raster scaling or deformation remains on the settled image. */}
      <img ref={image} className="chronicle-photo" alt="" />
      <img
        ref={incoming}
        className="chronicle-incoming"
        alt=""
        aria-hidden="true"
      />
      <canvas ref={canvas} aria-hidden="true" />
      {status === "loading" && (
        <p className="chronicle-media-status" role="status">
          Загружаем фотографию…
        </p>
      )}
      {status === "error" && (
        <div className="chronicle-media-status" role="alert">
          <p>Не удалось загрузить фотографию.</p>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Повторить
          </button>
        </div>
      )}
    </div>
  );
}
