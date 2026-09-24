import { useEffect, type RefObject } from "react";
import {
  zoomAt,
  type ZoomViewport,
} from "../components/tree/touch-zoom";

export function useCtrlWheelZoom(
  container: RefObject<HTMLElement | null>,
  flow: {
    getViewport: () => ZoomViewport;
    setViewport: (viewport: ZoomViewport) => Promise<boolean>;
  },
  enabled = true,
) {
  useEffect(() => {
    const element = container.current;
    if (!element || !enabled) return;

    let frame = 0;
    let pending: ZoomViewport | null = null;

    const flush = () => {
      frame = 0;
      if (!pending) return;
      const next = pending;
      pending = null;
      void flow.setViewport(next);
    };

    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();

      const box = element.getBoundingClientRect();
      const anchor = {
        x: Math.max(0, Math.min(box.width, event.clientX - box.left)),
        y: Math.max(0, Math.min(box.height, event.clientY - box.top)),
      };
      const base = pending || flow.getViewport();
      pending = zoomAt(base, anchor, Math.exp(-event.deltaY * 0.002));

      if (!frame) frame = requestAnimationFrame(flush);
    };

    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("wheel", wheel);
    };
  }, [container, flow, enabled]);
}
