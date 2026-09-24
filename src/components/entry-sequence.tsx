import { useEffect, useRef } from "react";

const ENTRY_KEY = "drevo:entry-sequence";
const ENTRY_WINDOW_MS = 10 * 60 * 1000;
const ENTRY_DURATION_MS = 1650;

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
  const skip = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!ready) return;
    skip.current?.focus();
    const timer = window.setTimeout(onFinish, ENTRY_DURATION_MS);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        onFinish();
      } else if (event.key === "Tab") {
        event.preventDefault();
        skip.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onFinish, ready]);

  return (
    <div
      className={`entry-sequence ${ready ? "is-ready" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Открываем семейный архив"
    >
      <div className="entry-sequence-grain" aria-hidden="true" />
      <svg
        className="entry-sequence-lines"
        viewBox="0 0 1000 600"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <path d="M500 495 V315 Q500 285 470 285 H265 Q235 285 235 255 V130" />
        <path d="M500 315 Q500 285 530 285 H735 Q765 285 765 255 V130" />
        <path d="M500 495 V390 Q500 360 530 360 H840" />
        <path d="M500 390 Q500 360 470 360 H160" />
        <circle cx="235" cy="130" r="5" />
        <circle cx="765" cy="130" r="5" />
        <circle cx="160" cy="360" r="5" />
        <circle cx="840" cy="360" r="5" />
        <circle cx="500" cy="495" r="5" />
      </svg>
      <div className="entry-sequence-title" aria-hidden="true">
        <span>СЕМЕЙНЫЙ АРХИВ</span>
        <strong>
          древо<span>.</span>
        </strong>
        <i />
      </div>
      {ready && (
        <button
          ref={skip}
          className="entry-sequence-skip"
          type="button"
          onClick={onFinish}
        >
          Пропустить
        </button>
      )}
    </div>
  );
}
