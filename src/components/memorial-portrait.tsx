import { useEffect, useRef, useState, type ReactNode } from "react";
import doveRest from "../assets/memorial-dove-rest.png";
import type { createDoveScene } from "./memorial-dove-scene";

const motionQuery =
  "(min-width: 900px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)";

/** Голубь уже сидит; 3D загружается только для открытого портрета на компьютере. */
export function MemorialPortrait({ children }: { children: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<Awaited<ReturnType<typeof createDoveScene>> | null>(
    null,
  );
  const [departed, setDeparted] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(motionQuery);
    const element = canvas.current;
    let controller: AbortController | undefined;
    const lost = () => {
      controller?.abort();
      scene.current?.dispose();
      scene.current = null;
      setReady(false);
      setDeparted(false);
    };
    const update = () => {
      controller?.abort();
      scene.current?.dispose();
      scene.current = null;
      setReady(false);
      setDeparted(false);
      if (!media.matches || !canvas.current) return;
      const request = new AbortController();
      controller = request;
      const target = canvas.current;
      void import("./memorial-dove-scene")
        .then(({ createDoveScene }) => {
          if (request.signal.aborted) return;
          return createDoveScene(target, request.signal);
        })
        .then((loaded) => {
          if (!loaded) return;
          if (request.signal.aborted) {
            loaded.dispose();
            return;
          }
          scene.current = loaded;
          setReady(true);
        })
        .catch(() => {
          /* При недоступном WebGL остаётся тот же голубь на статичном рендере. */
        });
    };
    update();
    element?.addEventListener("webglcontextlost", lost);
    media.addEventListener("change", update);
    return () => {
      element?.removeEventListener("webglcontextlost", lost);
      media.removeEventListener("change", update);
      controller?.abort();
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);
  return (
    <span
      className={`memorial-portrait${departed ? " dove-departed" : ""}`}
      onPointerEnter={(event) => {
        if (
          event.pointerType === "mouse" &&
          scene.current &&
          window.matchMedia(motionQuery).matches
        ) {
          scene.current.fly();
          setDeparted(true);
        }
      }}
    >
      {children}
      <span className="memorial-dove" role="img" aria-label="Светлая память">
        <img
          src={doveRest}
          alt=""
          className={ready ? "dove-hidden" : undefined}
        />
        <canvas
          ref={canvas}
          className={ready ? undefined : "dove-hidden"}
          aria-hidden="true"
        />
      </span>
    </span>
  );
}
