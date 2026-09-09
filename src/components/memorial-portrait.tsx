import { useState, type ReactNode } from "react";
import doveAtlas from "../assets/memorial-dove.png";

// Области оригинального прозрачного атласа. Все позы имеют одинаковый масштаб.
const poses = [
  { name: "idle", x: 0, y: 0, width: 650, height: 720, left: 0, top: 0 },
  { name: "up", x: 650, y: 0, width: 604, height: 720, left: 0, top: 0 },
  { name: "middle", x: 0, y: 730, width: 710, height: 524, left: 0, top: 160 },
  { name: "down", x: 710, y: 730, width: 544, height: 524, left: 60, top: 160 },
];

/** Голубь уже сидит. Только первый заход мыши запускает короткий взлёт. */
export function MemorialPortrait({ children }: { children: ReactNode }) {
  const [departed, setDeparted] = useState(false);
  return (
    <span
      className={`memorial-portrait${departed ? " dove-departed" : ""}`}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setDeparted(true);
      }}
    >
      {children}
      <span className="memorial-dove" role="img" aria-label="Светлая память">
        {poses.map((pose) => (
          <svg
            key={pose.name}
            className={`dove-frame dove-frame-${pose.name}`}
            viewBox="0 0 720 720"
            aria-hidden="true"
          >
            <svg
              x={pose.left}
              y={pose.top}
              width={pose.width}
              height={pose.height}
              viewBox={`${pose.x} ${pose.y} ${pose.width} ${pose.height}`}
              overflow="hidden"
            >
              <image href={doveAtlas} width="1254" height="1254" />
            </svg>
          </svg>
        ))}
      </span>
    </span>
  );
}
