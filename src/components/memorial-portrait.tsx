import { useEffect, useState, type ReactNode } from "react";
import doveAtlas from "../assets/memorial-dove-drawn.png";

const motionQuery =
  "(min-width: 900px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)";
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

/** Рисованная покадровая анимация: сидит сразу, один короткий взлёт. */
export function MemorialPortrait({ children }: { children: ReactNode }) {
  const [departed, setDeparted] = useState(false);
  const [frame, setFrame] = useState(0);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const image = new Image();
    image.onload = () => setLoaded(true);
    image.src = doveAtlas;
    return () => {
      image.onload = null;
    };
  }, []);
  useEffect(() => {
    if (!departed) return;
    const started = performance.now();
    const timer = window.setInterval(() => {
      const elapsed = performance.now() - started;
      if (elapsed >= 1680) {
        window.clearInterval(timer);
        setFrame(-1);
      } else setFrame(1 + (Math.floor(elapsed / 70) % 8));
    }, 35);
    return () => window.clearInterval(timer);
  }, [departed]);
  useEffect(() => {
    const media = window.matchMedia(motionQuery);
    const change = () => {
      if (!media.matches) {
        setDeparted(false);
        setFrame(0);
      }
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const pose = poses[Math.max(0, frame)];
  return (
    <span
      className={`memorial-portrait${departed ? " dove-departed" : ""}`}
      onPointerEnter={(event) => {
        if (
          !departed &&
          loaded &&
          event.pointerType === "mouse" &&
          window.matchMedia(motionQuery).matches
        ) {
          setFrame(1);
          setDeparted(true);
        }
      }}
    >
      {children}
      <span className="memorial-dove" role="img" aria-label="Светлая память">
        <svg
          viewBox="0 0 500 500"
          aria-hidden="true"
          style={{ visibility: frame < 0 ? "hidden" : undefined }}
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
