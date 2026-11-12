import { useEffect, useRef, useState } from "react";
import { mediaPreview } from "../../domain/media-preview";
import { photoLabel } from "../../domain/photo-metadata";
import type { ArchivePhoto } from "../../domain/types";
import { createLiquidGlassRenderer } from "./liquid-glass-renderer";
import { ChronicleLoading } from "./chronicle-loading";
import type { ChronicleSettings } from "../../shared/chronicle-settings.ts";

export function ChronicleStage({
  photo,
  settings,
  busy,
  takePreloaded,
  reduced,
  onBusy,
  onShown,
  onError,
  onFallback,
  onPrevious,
  onNext,
}: {
  photo: ArchivePhoto;
  settings: ChronicleSettings;
  busy: boolean;
  takePreloaded: (url: string) => HTMLImageElement | undefined;
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
  const retries = useRef({ photo: "", count: 0, startedAt: 0, retrying: false });
  const requestKey = JSON.stringify([photo.id, photo.url, attempt]);
  const [media, setMedia] = useState({ key: "", state: "loading" });
  const settingsRef = useRef(settings);
  // Settings affect the next transition, not the lifetime of the displayed photo.
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const status = media.key === requestKey ? media.state : "loading";
  useEffect(
    () => () => {
      renderer.current?.dispose(true);
      renderer.current = null;
    },
    [],
  );
  useEffect(() => {
    const transitionSettings = settingsRef.current;
    const retryKey = JSON.stringify([photo.id, photo.url]);
    if (retries.current.photo !== retryKey || !retries.current.retrying)
      retries.current = { photo: retryKey, count: 0, startedAt: Date.now(), retrying: false };
    else retries.current.retrying = false;
    let cancelled = false,
      frame = 0,
      started = 0,
      previousFrame = 0,
      slowFrames = 0,
      sampled = 0,
      announced = false;
    const resource = mediaPreview(photo.url, "display") || "";
    const preloaded = takePreloaded(resource);
    let target: HTMLImageElement | null = preloaded || new Image();
    const targetImage = target;
    const surface = canvas.current!,
      settled = image.current!,
      overlay = incoming.current!;
    onBusy(true);
    const indicator = window.setTimeout(() => setLoadingKey(requestKey),
      preloaded?.complete && preloaded.naturalWidth ? 250 : 0);
    let retryTimer = 0;
    const timeout = window.setTimeout(() => fail(false),
      Math.max(0, 20_000 - (Date.now() - retries.current.startedAt)));
    function fail(retryable = true) {
      if (cancelled) return;
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      if (retryable && !announced && !retryTimer && retries.current.count < 2 &&
        Date.now() - retries.current.startedAt < 19_000) {
        const delay = ++retries.current.count * 250;
        // Keep the last displayed photo and playback busy until a fresh Image
        // retries the resource. A failed background preload is never user error.
        retryTimer = window.setTimeout(() => {
          retries.current.retrying = true;
          setAttempt(value => value + 1);
        }, delay);
        return;
      }
      if (retryTimer) return;
      clearTimeout(indicator);
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
          announce();
          onBusy(false);
        });
      }).catch(() => fail());
    }
    function announce() {
      if (!announced) { announced = true; onShown(photo.id); }
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
        announce();
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
        announce();
        finish();
        return;
      }
      if (!fallback.current) {
        try {
          renderer.current ??= createLiquidGlassRenderer(surface);
          renderer.current.prepare(current.current.image, target, transitionSettings);
          renderer.current.render(0);
          surface.style.opacity = "1";
          glass = true;
        } catch {
          renderer.current?.dispose();
          renderer.current = null;
          degrade();
        }
      }
      const duration = glass ? transitionSettings.transitionDuration * 1000 : 450;
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
          if (t > 0) announce();
        } catch {
          degrade();
          overlay.style.opacity = "1";
          announce();
          finish();
          return;
        }
        if (glass && sampled >= 12 && slowFrames >= 8) {
          degrade();
          overlay.style.opacity = "1";
          announce();
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
    target.onerror = () => fail();
    if (!preloaded) target.src = resource;
    else if (preloaded.complete) queueMicrotask(() => {
      if (cancelled) return;
      if (!preloaded.naturalWidth) fail();
      else targetImage.onload?.call(targetImage, new Event("load"));
    });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      clearTimeout(indicator);
      clearTimeout(retryTimer);
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
    takePreloaded,
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
      <button type="button" className="chronicle-photo-advance" aria-label="Листать хронику дальше" disabled={busy} onClick={onNext} />
      {status === "loading" && (!hasShown || loadingKey === requestKey) && (
        <ChronicleLoading label="Загружаем фотографию…" />
      )}
      {status === "error" && (
        <div className="chronicle-media-status" role="alert">
          <p>Не удалось загрузить фотографию.</p>
          <button
            type="button"
            onClick={() => {
              retries.current.count = 0;
              retries.current.startedAt = Date.now();
              setAttempt((value) => value + 1);
            }}
          >
            Повторить
          </button>
        </div>
      )}
    </div>
  );
}
