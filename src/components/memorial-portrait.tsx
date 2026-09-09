import { useState, type ReactNode } from "react";

/** Одно приземление при открытии карточки, один взлёт при наведении. Без таймеров и циклов. */
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
        <svg viewBox="0 0 80 66" fill="none" aria-hidden="true">
          <g className="dove-flight">
            <path
              d="M43 49 41 56M50 48 50 56M37 56h8m1 0h9"
              stroke="#a28c6d"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d="m20 39-15 6 15-1-8 7 21-6"
              fill="#e5e8df"
              stroke="#a1b0a3"
              strokeLinejoin="round"
            />
            <path
              d="M21 38c4-10 20-13 27-8 1-9 3-16 12-16 10 0 12 12 5 16-5 3-6 7-9 12-4 8-14 12-24 8-7-3-10-7-11-12Z"
              fill="#fffefa"
              stroke="#9bad9e"
              strokeWidth="1.4"
            />
            <path
              className="dove-wing"
              d="M47 34C38 17 28 16 20 22c1 12 10 23 21 19l6-7Z"
              fill="#eef1e7"
              stroke="#a6b5a5"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <path d="m67 21 8 4-8 2" fill="#b7a17b" />
            <circle cx="62" cy="21" r="1.5" fill="#526654" />
            <path
              d="M31 30c3 4 6 6 10 7"
              stroke="#ced8c8"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </g>
        </svg>
      </span>
    </span>
  );
}
