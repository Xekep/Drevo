import { useEffect, useRef, useState } from "react";

const ENTRY_KEY = "drevo:entry-sequence";
const ENTRY_WINDOW_MS = 10 * 60 * 1000;
const ENTRY_HOLD_MS = 1600;
const ENTRY_EXIT_MS = 420;

export function markEntrySequence() {
  try {
    sessionStorage.setItem(ENTRY_KEY, String(Date.now()));
  } catch {
    // Signing in still works when session storage is unavailable.
  }
}

export function shouldPlayEntrySequence() {
  try {
    const started = Number(sessionStorage.getItem(ENTRY_KEY));
    if (!started || Date.now() - started > ENTRY_WINDOW_MS) {
      sessionStorage.removeItem(ENTRY_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function clearEntrySequence() {
  try {
    sessionStorage.removeItem(ENTRY_KEY);
  } catch {
    // Nothing to clear when session storage is unavailable.
  }
}

export function EntrySequence({
  onFinish,
  ready,
}: {
  onFinish: () => void;
  ready: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const startedAt = useRef<number | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (startedAt.current === null) startedAt.current = performance.now();
    const previousFocus = document.activeElement;
    container.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const elapsed =
      performance.now() - (startedAt.current ?? performance.now());
    const remaining = reduced ? 0 : Math.max(0, ENTRY_HOLD_MS - elapsed);
    const exitTimer = window.setTimeout(() => setExiting(true), remaining);
    const finishTimer = window.setTimeout(
      onFinish,
      remaining + (reduced ? 160 : ENTRY_EXIT_MS),
    );
    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(finishTimer);
    };
  }, [onFinish, ready]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        if (ready) onFinish();
      } else if (event.key === "Tab") {
        event.preventDefault();
        container.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onFinish, ready]);

  return (
    <div
      ref={container}
      tabIndex={-1}
      className={`entry-sequence ${ready ? "is-ready" : ""} ${ready && exiting ? "is-exiting" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Открываем семейный архив"
    >
      <div className="entry-sequence-grain" aria-hidden="true" />
      <div className="entry-sequence-heading" aria-hidden="true">
        <span />
        СЕМЕЙНЫЙ АРХИВ
        <span />
      </div>
      <div className="entry-sequence-composition" aria-hidden="true">
        <svg className="entry-sequence-tree" viewBox="0 0 480 300" fill="none">
          <ellipse
            className="entry-sequence-halo"
            cx="240"
            cy="142"
            rx="171"
            ry="124"
          />
          <g className="entry-sequence-roots">
            <path
              pathLength="1"
              d="M240 244 C240 263 226 265 206 276 M240 250 C247 263 260 269 278 275 M240 253 V285"
            />
          </g>
          <g className="entry-sequence-boughs">
            <path
              pathLength="1"
              d="M240 252 C239 218 232 190 240 160 C245 131 240 100 240 44"
            />
            <path
              pathLength="1"
              d="M238 211 C220 184 181 181 164 151 C151 128 154 101 138 80"
            />
            <path
              pathLength="1"
              d="M240 218 C264 185 297 177 315 146 C330 121 328 98 346 76"
            />
            <path
              pathLength="1"
              d="M238 171 C217 149 204 134 202 109 C201 87 204 70 190 53"
            />
            <path
              pathLength="1"
              d="M241 157 C264 133 280 117 278 94 C277 78 282 61 292 49"
            />
            <path
              pathLength="1"
              d="M176 166 C149 160 126 164 105 146 C92 135 89 119 75 108"
            />
            <path
              pathLength="1"
              d="M301 165 C330 157 354 159 374 142 C386 131 390 114 405 104"
            />
          </g>
          <g className="entry-sequence-twigs">
            <path
              pathLength="1"
              d="M240 105 C225 91 224 76 225 64 M241 124 C256 109 262 93 259 78 M202 118 C185 112 177 97 174 84 M278 108 C296 102 304 89 306 76"
            />
            <path
              pathLength="1"
              d="M157 130 C138 126 126 112 121 98 M160 140 C173 128 180 116 179 105 M115 153 C114 138 109 128 103 121 M138 160 C127 177 108 181 90 178"
            />
            <path
              pathLength="1"
              d="M324 129 C344 122 354 111 361 95 M319 140 C305 129 301 117 302 108 M365 149 C366 135 372 122 378 116 M341 158 C355 174 374 178 392 174"
            />
          </g>
          <g className="entry-sequence-leaves">
            <path d="M240 44 C230 35 233 25 240 19 C247 26 250 35 240 44Z M138 80 C127 79 120 71 121 61 C131 62 139 69 138 80Z M346 76 C346 64 354 57 364 57 C364 68 356 76 346 76Z" />
            <path d="M190 53 C179 51 174 44 177 34 C187 36 192 43 190 53Z M292 49 C291 38 298 31 307 29 C309 39 302 46 292 49Z M75 108 C64 109 56 102 55 93 C65 90 74 97 75 108Z M405 104 C407 93 415 88 425 90 C423 100 415 106 405 104Z" />
          </g>
          <g className="entry-sequence-buds">
            <circle cx="225" cy="64" r="2.4" />
            <circle cx="259" cy="78" r="2.4" />
            <circle cx="174" cy="84" r="2.4" />
            <circle cx="306" cy="76" r="2.4" />
            <circle cx="121" cy="98" r="2.4" />
            <circle cx="361" cy="95" r="2.4" />
            <circle cx="179" cy="105" r="2" />
            <circle cx="302" cy="108" r="2" />
            <circle cx="103" cy="121" r="2" />
            <circle cx="378" cy="116" r="2" />
            <circle cx="90" cy="178" r="2.4" />
            <circle cx="392" cy="174" r="2.4" />
          </g>
          <circle className="entry-sequence-seed" cx="240" cy="252" r="3" />
        </svg>
        <div className="entry-sequence-title">
          <strong>
            древо<span>.</span>
          </strong>
          <p>История начинается с семьи.</p>
        </div>
      </div>
      <div className="entry-sequence-status" role="status">
        <span aria-hidden="true" />
        {ready ? "Архив готов" : "Открываем архив…"}
      </div>
    </div>
  );
}
