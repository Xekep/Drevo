import { useEffect, type RefObject } from "react";
import {
  isSecondTap,
  zoomAt,
  type TimedTouch,
  type ZoomViewport,
} from "../components/tree/touch-zoom";

/** Двойное касание + движение одним пальцем. Обычные pan и pinch получает React Flow. */
export function useTouchZoom(
  container: RefObject<HTMLElement | null>,
  flow: {
    getViewport: () => ZoomViewport;
    setViewport: (viewport: ZoomViewport) => Promise<boolean>;
  },
) {
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let previous: TimedTouch | null = null;
    let first: TimedTouch | null = null;
    let active: {
      start: TimedTouch;
      viewport: ZoomViewport;
      anchor: { x: number; y: number };
      moved: boolean;
    } | null = null;
    let consume = false;
    let frame = 0;
    let pending: ZoomViewport | null = null;
    const point = (event: TouchEvent): TimedTouch => ({
      x: event.changedTouches[0].clientX,
      y: event.changedTouches[0].clientY,
      time: event.timeStamp,
    });
    const stop = (event: TouchEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const flush = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (pending) void flow.setViewport(pending);
      pending = null;
    };
    const start = (event: TouchEvent) => {
      if (consume) {
        stop(event);
        active = null;
        return;
      }
      if (
        event.touches.length !== 1 ||
        !(event.target instanceof Element) ||
        !event.target.closest(".react-flow__pane, .react-flow__edge") ||
        event.target.closest(
          "button, a, input, .react-flow__node, .react-flow__panel, .nopan",
        )
      ) {
        previous = first = null;
        return;
      }
      const next = point(event);
      if (isSecondTap(previous, next)) {
        const box = element.getBoundingClientRect();
        active = {
          start: next,
          viewport: flow.getViewport(),
          anchor: { x: next.x - box.left, y: next.y - box.top },
          moved: false,
        };
        consume = true;
        previous = first = null;
        stop(event);
      } else first = next;
    };
    const move = (event: TouchEvent) => {
      if (consume) {
        stop(event);
        if (!active || event.touches.length !== 1) {
          active = null;
          return;
        }
        const next = point(event);
        if (Math.hypot(next.x - active.start.x, next.y - active.start.y) > 8)
          active.moved = true;
        if (active.moved) {
          pending = zoomAt(
            active.viewport,
            active.anchor,
            Math.exp((active.start.y - next.y) * 0.008),
          );
          if (!frame) frame = requestAnimationFrame(flush);
        }
      } else if (first) {
        const next = point(event);
        if (
          event.touches.length !== 1 ||
          Math.hypot(next.x - first.x, next.y - first.y) > 10
        )
          previous = first = null;
      }
    };
    const end = (event: TouchEvent) => {
      if (consume) {
        stop(event);
        if (active && !active.moved)
          pending = zoomAt(active.viewport, active.anchor, 1.6);
        flush();
        active = null;
        if (!event.touches.length) consume = false;
      } else if (first) {
        const next = point(event);
        previous =
          !event.touches.length &&
          next.time - first.time <= 250 &&
          Math.hypot(next.x - first.x, next.y - first.y) <= 10
            ? next
            : null;
      }
      first = null;
    };
    const cancel = (event: TouchEvent) => {
      if (consume) stop(event);
      flush();
      active = previous = first = null;
      consume = consume && event.touches.length > 0;
    };
    const options = { capture: true, passive: false };
    element.addEventListener("touchstart", start, options);
    element.addEventListener("touchmove", move, options);
    element.addEventListener("touchend", end, options);
    element.addEventListener("touchcancel", cancel, options);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("touchstart", start, options);
      element.removeEventListener("touchmove", move, options);
      element.removeEventListener("touchend", end, options);
      element.removeEventListener("touchcancel", cancel, options);
    };
  }, [container, flow]);
}
