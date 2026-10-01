import { useLayoutEffect, type RefObject } from "react";

/** Keep camera gestures from remounting virtualized arrows during the intro. */
export function useTreeGrowthInputLock(
  container: RefObject<HTMLElement | null>,
  locked: boolean,
  allowPersonSelection = false,
) {
  // Sync interception before the browser can interact with newly enabled
  // toolbar controls. A passive effect can leave the previous lock installed.
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !locked) return;
    const stop = (event: Event) => {
      // Preferences can reduce the projection and cancel a slow initial layout.
      if (
        event.type !== "wheel" &&
        event.target instanceof Element &&
        event.target.closest(".tree-preferences-trigger")
      )
        return;
      // An explicit selection or mode change may cancel the personal camera
      // move; stray background clicks and wheel gestures must not interrupt it.
      if (
        allowPersonSelection &&
        event.type !== "wheel" &&
        event.target instanceof Element &&
        event.target.closest(
          ".flow-person-content, .tree-mode-bar, .tree-display-actions",
        )
      )
        return;
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
  }, [container, locked, allowPersonSelection]);
}
