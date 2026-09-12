import { useEffect, useState, type ReactNode } from "react";
import doveAtlas from "../assets/memorial-dove-drawn.png";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
// Области оригинального атласа; рисунки совмещены по положению головы.
const poses = [
  { x: 0, y: 140, w: 430, h: 285, eyeX: 297, eyeY: 236 },
  { x: 470, y: 0, w: 365, h: 425, eyeX: 748, eyeY: 230 },
  { x: 875, y: 0, w: 379, h: 425, eyeX: 1174, eyeY: 236 },
  { x: 0, y: 540, w: 475, h: 285, eyeX: 330, eyeY: 611 },
  { x: 480, y: 550, w: 395, h: 275, eyeX: 759, eyeY: 609 },
  { x: 880, y: 540, w: 374, h: 305, eyeX: 1163, eyeY: 607 },
  { x: 0, y: 915, w: 430, h: 325, eyeX: 330, eyeY: 1026 },
  { x: 450, y: 845, w: 395, h: 395, eyeX: 773, eyeY: 1025 },
  { x: 870, y: 820, w: 384, h: 420, eyeX: 1173, eyeY: 1024 },
];

/** Один пролёт при открытии профиля; вся анимация остаётся внутри этого компонента. */
export function MemorialName({ children }: { children: ReactNode }) {
  const [flight, setFlight] = useState({ phase: "waiting", frame: 0 });
  useEffect(() => {
    const media = window.matchMedia(reducedMotionQuery);
    const image = new Image();
    let disposed = false,
      begun = false,
      timer = 0,
      started = 0,
      lastFrame = -1;
    const stop = () => window.cancelAnimationFrame(timer);
    const still = () => {
      stop();
      setFlight({ phase: "still", frame: 0 });
    };
    const tick = (now: number) => {
      if (disposed) return;
      const elapsed = now - started;
      if (elapsed >= 1900) {
        setFlight({ phase: "finished", frame: 0 });
        return;
      }
      const frame = 1 + (Math.floor(elapsed / 70) % 8);
      if (frame !== lastFrame) {
        lastFrame = frame;
        setFlight({ phase: "flying", frame });
      }
      timer = window.requestAnimationFrame(tick);
    };
    const begin = () => {
      if (disposed || begun) return;
      begun = true;
      if (media.matches) return still();
      started = performance.now();
      setFlight({ phase: "flying", frame: 1 });
      timer = window.requestAnimationFrame(tick);
    };
    const change = () => {
      // Явный reduce немедленно останавливает пролёт.
      // Обратное переключение не запускает его повторно.
      if (media.matches) still();
    };
    media.addEventListener("change", change);
    image.onload = begin;
    // A failed preload must not leave the memorial permanently hidden. The
    // nested SVG image can still be served from cache or finish separately.
    image.onerror = begin;
    image.src = doveAtlas;
    if (image.complete) begin();
    // decode() is reliable on mobile browsers that can skip a cached load
    // event; onload remains the fallback for older engines.
    void image.decode?.().then(begin, begin);
    return () => {
      disposed = true;
      stop();
      image.onload = null;
      image.onerror = null;
      media.removeEventListener("change", change);
    };
  }, []);
  const pose = poses[flight.frame];
  return (
    <span
      className={`memorial-name${flight.phase === "flying" ? " dove-departed" : ""}`}
    >
      {children}
      <span className="memorial-dove" role="img" aria-label="Светлая память">
        <svg
          viewBox="0 0 500 500"
          aria-hidden="true"
          style={{
            visibility: ["waiting", "finished"].includes(flight.phase)
              ? "hidden"
              : undefined,
          }}
        >
          <svg
            x={pose.x - pose.eyeX + 330}
            y={pose.y - pose.eyeY + 235}
            width={pose.w}
            height={pose.h}
            viewBox={`${pose.x} ${pose.y} ${pose.w} ${pose.h}`}
            overflow="hidden"
          >
            <image href={doveAtlas} width="1254" height="1254" />
          </svg>
        </svg>
      </span>
    </span>
  );
}
