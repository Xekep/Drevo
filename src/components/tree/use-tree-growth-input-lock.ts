import { useEffect, type RefObject } from "react";

/** Keep camera gestures from remounting virtualized arrows during the intro. */
export function useTreeGrowthInputLock(
  container: RefObject<HTMLElement | null>,
  locked: boolean,
) {
  useEffect(() => {
    const element = container.current;
    if (!element || !locked) return;
    const stop = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = [
      "wheel",
      "pointerdown",
      "mousedown",
      "click",
      "auxclick",
      "dblclick",
      "contextmenu",
    ] as const;
    // The overlay catches clicks, but wheel events still bubble to the custom
    // Ctrl+wheel handler (and can trigger browser zoom). Intercept before both.
    const options = { capture: true, passive: false };
    for (const name of events) element.addEventListener(name, stop, options);
    return () => {
      for (const name of events)
        element.removeEventListener(name, stop, options);
    };
  }, [container, locked]);
}
