import { dockSwipeAction, dockSwipeIntent } from "./dock-swipe.ts";

/** Claim a pull at the top while keeping ordinary content scrolling native. */
export function bindDockContentSwipe(
  panel: HTMLElement,
  heading: HTMLElement,
  expanded: boolean,
  onClose: () => void,
  onExpand: () => void,
) {
  let gesture: {
    id: number;
    x: number;
    y: number;
    time: number;
    atTop: boolean;
    fromHeading: boolean;
    mode: "pending" | "scroll" | "drag";
  } | null = null;
  let ignoreClickUntil = 0;
  const reset = () => {
    gesture = null;
    panel.classList.remove("is-dragging");
    panel.style.removeProperty("--dock-drag");
  };
  const start = (event: TouchEvent) => {
    reset();
    ignoreClickUntil = 0;
    if (event.touches.length !== 1 || !matchMedia("(max-width: 899px)").matches)
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (
      !target ||
      target.closest(
        "input, textarea, select, [contenteditable=true], dialog, [role=dialog]",
      )
    )
      return;
    if (window.getSelection()?.toString()) return;
    let atTop = true;
    for (let node: Element | null = target; node; node = node.parentElement) {
      if (node.scrollTop > 1) atTop = false;
      if (node === panel) break;
    }
    const touch = event.touches[0];
    gesture = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      time: event.timeStamp,
      atTop,
      fromHeading: heading.contains(target),
      mode: "pending",
    };
  };
  const move = (event: TouchEvent) => {
    if (!gesture) return;
    if (event.touches.length !== 1) {
      reset();
      return;
    }
    const touch = event.touches[0];
    if (touch.identifier !== gesture.id) {
      reset();
      return;
    }
    const dx = touch.clientX - gesture.x,
      dy = touch.clientY - gesture.y;
    if (gesture.mode === "pending")
      gesture.mode = dockSwipeIntent(
        dx,
        dy,
        gesture.atTop,
        gesture.fromHeading,
        expanded,
      );
    if (gesture.mode !== "drag") return;
    if (!event.cancelable) {
      reset();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    panel.classList.add("is-dragging");
    panel.style.setProperty(
      "--dock-drag",
      `${dy > 0 ? dy : expanded ? 0 : Math.max(-48, dy * 0.3)}px`,
    );
  };
  const end = (event: TouchEvent) => {
    const current = gesture;
    const touch = Array.from(event.changedTouches).find(
      (t) => t.identifier === current?.id,
    );
    if (!current || !touch || event.touches.length || current.mode !== "drag") {
      reset();
      return;
    }
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    ignoreClickUntil = Date.now() + 500;
    const action = dockSwipeAction(
      touch.clientX - current.x,
      touch.clientY - current.y,
      event.timeStamp - current.time,
      expanded,
    );
    reset();
    if (action === "close") onClose();
    if (action === "expand") onExpand();
  };
  const cancel = () => {
    if (gesture?.mode === "drag") ignoreClickUntil = Date.now() + 500;
    reset();
  };
  const click = (event: MouseEvent) => {
    if (event.detail && Date.now() < ignoreClickUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  panel.addEventListener("touchstart", start, { passive: true });
  panel.addEventListener("touchmove", move, { passive: false });
  panel.addEventListener("touchend", end, { passive: false });
  panel.addEventListener("touchcancel", cancel);
  panel.addEventListener("click", click, true);
  window.addEventListener("resize", cancel);
  return () => {
    reset();
    panel.removeEventListener("touchstart", start);
    panel.removeEventListener("touchmove", move);
    panel.removeEventListener("touchend", end);
    panel.removeEventListener("touchcancel", cancel);
    panel.removeEventListener("click", click, true);
    window.removeEventListener("resize", cancel);
  };
}
