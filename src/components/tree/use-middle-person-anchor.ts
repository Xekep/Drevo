import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

/** A short middle click chooses a person; a middle drag remains camera pan. */
export function useMiddlePersonAnchor(
  enabled: boolean,
  personAt: (target: EventTarget, x: number, y: number) => string | null,
  choose: (id: string) => void,
) {
  const gesture = useRef<{
    id: string;
    x: number;
    y: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const start = gesture.current;
      if (
        start &&
        event.pointerId === start.pointerId &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 4
      )
        start.moved = true;
    };
    const cancel = () => {
      gesture.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  return {
    onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
      gesture.current = null;
      if (!enabled || event.button !== 1 || event.pointerType !== "mouse")
        return;
      const id = personAt(event.target, event.clientX, event.clientY);
      if (id)
        gesture.current = {
          id,
          x: event.clientX,
          y: event.clientY,
          pointerId: event.pointerId,
          moved: false,
        };
    },
    onMouseDownCapture(event: MouseEvent<HTMLDivElement>) {
      // Prevent browser autoscroll, but let React Flow receive mousedown for pan.
      if (event.button === 1 && gesture.current) event.preventDefault();
    },
    onAuxClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (event.button !== 1) return;
      const start = gesture.current;
      gesture.current = null;
      if (!start) return;
      event.preventDefault();
      event.stopPropagation();
      if (
        enabled &&
        !start.moved &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4 &&
        personAt(event.target, event.clientX, event.clientY) === start.id
      )
        choose(start.id);
    },
  };
}
