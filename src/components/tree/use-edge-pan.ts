import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type { ReactFlowInstance } from "@xyflow/react";

type Camera = Pick<ReactFlowInstance, "getViewport" | "setViewport">;

// React Flow marks every edge as `nopan` so a click can select it. Handle a
// drag that starts on an edge separately, while leaving short clicks intact.
export function useEdgePan(camera: Camera, enabled: boolean) {
  const removeListeners = useRef<() => void>(() => {});
  const suppressClick = useRef(false);
  const resetClickTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      removeListeners.current();
      if (resetClickTimer.current !== null)
        window.clearTimeout(resetClickTimer.current);
    },
    [],
  );

  const onPointerDownCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        !enabled ||
        event.pointerType !== "mouse" ||
        !event.isPrimary ||
        (event.button !== 0 && event.button !== 1)
      )
        return;
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest(".react-flow__edge, .flow-edge-label") ||
        target.closest(".react-flow__edgeupdater")
      )
        return;

      removeListeners.current();
      if (resetClickTimer.current !== null)
        window.clearTimeout(resetClickTimer.current);
      suppressClick.current = false;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const start = camera.getViewport();
      let dragged = false;

      const move = (next: globalThis.PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        const dx = next.clientX - startX;
        const dy = next.clientY - startY;
        if (!dragged && Math.hypot(dx, dy) < 4) return;
        dragged = true;
        suppressClick.current = true;
        next.preventDefault();
        void camera.setViewport({
          x: start.x + dx,
          y: start.y + dy,
          zoom: start.zoom,
        });
      };
      const end = (next: globalThis.PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        removeListeners.current();
        // The browser dispatches click after pointerup. Suppress only that
        // click; the next ordinary click must still select a connection.
        if (dragged)
          resetClickTimer.current = window.setTimeout(() => {
            suppressClick.current = false;
            resetClickTimer.current = null;
          }, 0);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      removeListeners.current = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        removeListeners.current = () => {};
      };
    },
    [camera, enabled],
  );

  const onClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick.current = false;
  }, []);

  return { onPointerDownCapture, onClickCapture };
}
