import { useEffect, useRef, useState } from "react";
import { mediaPreview } from "../../domain/media-preview";
import { photoLabel } from "../../domain/photo-metadata";
import type { ArchivePhoto } from "../../domain/types";
import { createLiquidGlassRenderer } from "./liquid-glass-renderer";
import { ChronicleLoading } from "./chronicle-loading";

export function ChronicleStage({
  photo,
  reduced,
  onBusy,
  onShown,
  onError,
  onFallback,
  onPrevious,
  onNext,
}: {
  photo: ArchivePhoto;
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
  const fallback = useRef(false);
  const [hasShown, setHasShown] = useState(false);
  const [loadingKey, setLoadingKey] = useState("");
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
    const indicator = window.setTimeout(() => setLoadingKey(requestKey), 250);
    const timeout = window.setTimeout(fail, 20_000);
    function fail() {
      if (cancelled) return;
      clearTimeout(timeout);
      clearTimeout(indicator);
      cancelAnimationFrame(frame);
      setMedia({ key: requestKey, state: "error" });
      surface.style.opacity = "0";
      overlay.style.opacity = "0";
      onBusy(false);
      onError();
    }
    function finish() {
      if (cancelled || !target) return;
      // Keep the decoded incoming layer / last GPU frame until the actual DOM
      // image is decoded, then exchange layers together on the next paint.
      settled.src = target.src;
      settled.alt = photoLabel(photo);
      const shown = target;
      void settled.decode().then(() => {
        if (cancelled) return;
        frame = requestAnimationFrame(() => {
          if (cancelled) return;
          current.current = { id: photo.id, image: shown };
          setHasShown(true);
          surface.style.opacity = "0";
          overlay.style.opacity = "0";
          onShown(photo.id);
          onBusy(false);
        });
      }).catch(fail);
    }
    function degrade() {
      fallback.current = true;
      onFallback();
    }
    let glass = false;
    function lost(event: Event) {
      event.preventDefault();
      if (cancelled) return;
      glass = false;
      renderer.current?.dispose();
      renderer.current = null;
      degrade();
      cancelAnimationFrame(frame);
      if (target?.complete && target.naturalWidth) {
        overlay.style.opacity = "1";
        finish();
      }
    }
    surface.addEventListener("webglcontextlost", lost);
    target.onload = async () => {
      if (cancelled || !target) return;
      try {
        await target.decode();
        if (cancelled || !target) return;
        overlay.src = target.src;
        await overlay.decode();
        if (cancelled || !target) return;
      } catch {
        fail();
        return;
      }
      clearTimeout(timeout);
      clearTimeout(indicator);
      setMedia({ key: requestKey, state: "ready" });
      if (!current.current || reduced || current.current.id === photo.id) {
        overlay.style.opacity = "1";
        finish();
        return;
      }
      if (!fallback.current) {
        try {
          renderer.current ??= createLiquidGlassRenderer(surface);
          renderer.current.prepare(current.current.image, target);
          renderer.current.render(0);
          surface.style.opacity = "1";
          glass = true;
        } catch {
          renderer.current?.dispose();
          renderer.current = null;
          degrade();
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
          degrade();
          overlay.style.opacity = "1";
          finish();
          return;
        }
        if (glass && sampled >= 12 && slowFrames >= 8) {
          degrade();
          overlay.style.opacity = "1";
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
      clearTimeout(indicator);
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
      data-has-photo={hasShown}
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
      <canvas ref={canvas} className="chronicle-transition" aria-hidden="true" />
      <button type="button" className="chronicle-photo-advance" aria-label="Листать хронику дальше" onClick={onNext} />
      {status === "loading" && (!hasShown || loadingKey === requestKey) && (
        <ChronicleLoading label="Загружаем фотографию…" />
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
