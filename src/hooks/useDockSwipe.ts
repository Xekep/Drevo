import { useEffect, type RefObject } from "react";
import { dockSwipeAction } from "../components/dock-swipe";
import { bindDockContentSwipe } from "../components/dock-content-swipe";

export function useDockSwipe(
  panel: RefObject<HTMLElement | null>,
  heading: RefObject<HTMLElement | null>,
  expanded: boolean,
  enabled: boolean,
  onClose: () => void,
  onExpand: () => void,
  wholePanel = false,
) {
  useEffect(() => {
    const element = panel.current,
      handle = heading.current;
    if (!element || !handle || !enabled) return;
    if (wholePanel)
      return bindDockContentSwipe(element, handle, expanded, onClose, onExpand);
    let gesture: { id: number; x: number; y: number; time: number } | null =
      null;
    let moved = false;
    const reset = () => {
      const id = gesture?.id;
      gesture = null;
      element.classList.remove("is-dragging");
      element.style.removeProperty("--dock-drag");
      if (id !== undefined && handle.hasPointerCapture(id))
        handle.releasePointerCapture(id);
    };
    const down = (event: PointerEvent) => {
      if (!event.isPrimary) {
        reset();
        return;
      }
      if (
        event.pointerType === "mouse" ||
        !matchMedia("(max-width: 899px)").matches
      )
        return;
      moved = false;
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
      };
    };
    const move = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const dx = event.clientX - gesture.x,
        dy = event.clientY - gesture.y;
      if (!moved && Math.hypot(dx, dy) < 8) return;
      moved = true;
      handle.setPointerCapture(event.pointerId);
      element.classList.add("is-dragging");
      const offset =
        Math.abs(dy) >= Math.abs(dx) * 1.4
          ? dy > 0
            ? dy
            : expanded
              ? 0
              : Math.max(-48, dy * 0.3)
          : 0;
      element.style.setProperty("--dock-drag", `${offset}px`);
    };
    const up = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const action = moved
        ? dockSwipeAction(
            event.clientX - gesture.x,
            event.clientY - gesture.y,
            event.timeStamp - gesture.time,
            expanded,
          )
        : "reset";
      reset();
      if (action === "close") onClose();
      if (action === "expand") onExpand();
    };
    const click = (event: MouseEvent) => {
      if (moved && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
        moved = false;
      }
    };
    const lostCapture = (event: PointerEvent) => {
      // При переносе неявного захвата с кнопки на заголовок её событие всплывает сюда.
      if (event.target === handle && event.pointerId === gesture?.id) reset();
    };
    handle.addEventListener("pointerdown", down);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", reset);
    handle.addEventListener("lostpointercapture", lostCapture);
    handle.addEventListener("click", click, true);
    window.addEventListener("resize", reset);
    return () => {
      reset();
      handle.removeEventListener("pointerdown", down);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", reset);
      handle.removeEventListener("lostpointercapture", lostCapture);
      handle.removeEventListener("click", click, true);
      window.removeEventListener("resize", reset);
    };
  }, [panel, heading, expanded, enabled, onClose, onExpand, wholePanel]);
}
