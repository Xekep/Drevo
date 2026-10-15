import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ArchiveView } from "../domain/archive-routes";

export type EditorFocusRequest = {
  opener: HTMLElement | null;
  tag: string;
  label: string | null;
  text: string;
  markOpened: () => void;
  hasOpened: () => boolean;
  restorePending?: boolean;
};

export function captureEditorFocus(): EditorFocusRequest {
  let opened = false;
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : null;
  return {
    opener,
    tag: opener?.tagName.toLowerCase() || "button",
    label: opener?.getAttribute("aria-label") || null,
    text: opener?.textContent?.trim() || "",
    markOpened: () => { opened = true; },
    hasOpened: () => opened,
  };
}

function available(element: HTMLElement | null): boolean {
  return !!element?.isConnected && !element.closest("[inert], [hidden]") &&
    element.getClientRects().length > 0;
}

function viewTarget(view?: ArchiveView): HTMLElement | null {
  const selector = view === "tree"
    ? ".inspector-dock h2, .tree-canvas"
    : "main h1, .archive-workspace h1, .archive-status h1";
  return [...document.querySelectorAll<HTMLElement>(selector)].find(available) || null;
}

function focusHeading(target: HTMLElement) {
  if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

// The shell owns the intent; a lazy view may supply its heading later. Stop
// waiting as soon as the user chooses another focus target or interacts again.
export function useExplicitViewFocus(view: ArchiveView) {
  const [request, setRequest] = useState<{ view: ArchiveView; source: Element | null } | null>(null);
  const completedRequest = useRef<typeof request>(null);
  const requestFocus = useCallback((next: ArchiveView) => {
    setRequest({ view: next, source: document.activeElement });
  }, []);
  useLayoutEffect(() => {
    if (!request || request.view !== view || completedRequest.current === request) return;
    let finished = false;
    const observer = new MutationObserver(attempt);
    function stop() {
      finished = true;
      completedRequest.current = request;
      observer.disconnect();
      document.removeEventListener("focusin", moved);
      document.removeEventListener("pointerdown", stop);
      document.removeEventListener("keydown", stop);
    }
    function moved(event: FocusEvent) {
      if (event.target !== request?.source) stop();
    }
    function attempt() {
      if (finished) return;
      const target = viewTarget(view);
      if (!target) return;
      stop();
      focusHeading(target);
    }
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("focusin", moved);
    document.addEventListener("pointerdown", stop);
    document.addEventListener("keydown", stop);
    attempt();
    return stop;
  }, [request, view]);
  return requestFocus;
}

// Focus a static heading, so opening a touch editor does not summon a keyboard.
// The request was captured before the opener (and possibly its entire view)
// unmounted, rather than when the lazy editor finally became ready.
export function useInlineEditorFocus(
  ref: RefObject<HTMLElement | null>,
  request: EditorFocusRequest | undefined,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!enabled || !request || !node) return;
    request.markOpened();
    const active = document.activeElement;
    if (active === document.body || active === request.opener) {
      const heading = node.querySelector<HTMLElement>("header h2");
      if (heading) focusHeading(heading);
    }
    return () => {
      requestAnimationFrame(() => {
        // React's development effect replay is not a closed editor.
        if (available(node)) return;
        request.restorePending = false;
        const active = document.activeElement;
        if (active && active !== document.body && !node.contains(active)) return;
        const replacement = [...document.querySelectorAll<HTMLElement>(request.tag)]
          .find((element) => available(element) && (request.label
            ? element.getAttribute("aria-label") === request.label
            : !!request.text && element.textContent?.trim() === request.text));
        const target = available(request.opener) ? request.opener : replacement;
        if (target) target.focus({ preventScroll: true });
        else {
          const heading = viewTarget() || viewTarget("tree");
          if (heading) focusHeading(heading);
        }
      });
    };
  }, [enabled, ref, request]);
}
