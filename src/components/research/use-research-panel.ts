import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

type PanelPosition = { left: number; top: number };
type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
type PanelRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export const RESIZE_DIRECTIONS: Array<{
  direction: ResizeDirection;
  label: string;
}> = [
  {
    direction: "n",
    label: "Изменить высоту сверху",
  },
  { direction: "ne", label: "Изменить размер сверху справа" },
  { direction: "e", label: "Изменить ширину справа" },
  { direction: "se", label: "Изменить размер снизу справа" },
  { direction: "s", label: "Изменить высоту снизу" },
  { direction: "sw", label: "Изменить размер снизу слева" },
  { direction: "w", label: "Изменить ширину слева" },
  { direction: "nw", label: "Изменить размер сверху слева" },
];

function resizedPanelRect(
  rect: PanelRect,
  direction: ResizeDirection,
  deltaX: number,
  deltaY: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const margin = 8,
    minWidth = Math.min(340, viewportWidth - margin * 2),
    minHeight = Math.min(420, viewportHeight - margin * 2);
  let left = rect.left,
    right = rect.left + rect.width,
    top = rect.top,
    bottom = rect.top + rect.height;
  if (direction.includes("e"))
    right = Math.min(
      viewportWidth - margin,
      Math.max(left + minWidth, right + deltaX),
    );
  if (direction.includes("w"))
    left = Math.max(margin, Math.min(right - minWidth, left + deltaX));
  if (direction.includes("s"))
    bottom = Math.min(
      viewportHeight - margin,
      Math.max(top + minHeight, bottom + deltaY),
    );
  if (direction.includes("n"))
    top = Math.max(margin, Math.min(bottom - minHeight, top + deltaY));
  return { left, top, width: right - left, height: bottom - top };
}

export function useResearchPanel(open: boolean) {
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(
    null,
  );
  const panel = useRef<HTMLElement>(null),
    drag = useRef<{
      pointerId: number;
      offsetX: number;
      offsetY: number;
      left: number;
      top: number;
    } | null>(null),
    resize = useRef<{
      pointerId: number;
      direction: ResizeDirection;
      startX: number;
      startY: number;
      startRect: PanelRect;
      latest: PanelRect;
    } | null>(null);
  const clampPanelPosition = useCallback((left: number, top: number) => {
    const rect = panel.current?.getBoundingClientRect(),
      width = rect?.width || 430,
      height = rect?.height || 680,
      margin = 8;
    return {
      left: Math.min(
        Math.max(margin, left),
        Math.max(margin, innerWidth - width - margin),
      ),
      top: Math.min(
        Math.max(margin, top),
        Math.max(margin, innerHeight - height - margin),
      ),
    };
  }, []);

  useEffect(() => {
    const keepVisible = () =>
      setPanelPosition((current) =>
        current ? clampPanelPosition(current.left, current.top) : current,
      );
    window.addEventListener("resize", keepVisible);
    return () => window.removeEventListener("resize", keepVisible);
  }, [clampPanelPosition]);

  useEffect(() => {
    if (!open || !panel.current || typeof ResizeObserver === "undefined")
      return;
    const observer = new ResizeObserver(() => {
      setPanelPosition((current) => {
        if (!current) return current;
        const next = clampPanelPosition(current.left, current.top);
        return next.left === current.left && next.top === current.top
          ? current
          : next;
      });
    });
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, [open, clampPanelPosition]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      innerWidth <= 600 ||
      (event.target as HTMLElement).closest(
        "button, a, input, select, textarea",
      )
    )
      return;
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      left: rect.left,
      top: rect.top,
    };
    setPanelPosition({ left: rect.left, top: rect.top });
    panel.current?.classList.add("is-dragging");
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const next = clampPanelPosition(
      event.clientX - state.offsetX,
      event.clientY - state.offsetY,
    );
    state.left = next.left;
    state.top = next.top;
    if (panel.current) {
      panel.current.style.left = `${next.left}px`;
      panel.current.style.top = `${next.top}px`;
      panel.current.style.right = "auto";
      panel.current.style.bottom = "auto";
    }
  };

  const stopDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const state = drag.current;
    drag.current = null;
    panel.current?.classList.remove("is-dragging");
    setPanelPosition({ left: state.left, top: state.top });
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const applyPanelRect = (next: PanelRect) => {
    if (!panel.current) return;
    panel.current.style.left = `${next.left}px`;
    panel.current.style.top = `${next.top}px`;
    panel.current.style.right = "auto";
    panel.current.style.bottom = "auto";
    panel.current.style.width = `${next.width}px`;
    panel.current.style.height = `${next.height}px`;
  };

  const startResize = (
    direction: ResizeDirection,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0 || innerWidth <= 600 || !panel.current) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = panel.current.getBoundingClientRect(),
      startRect = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    resize.current = {
      pointerId: event.pointerId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startRect,
      latest: startRect,
    };
    setPanelPosition({ left: rect.left, top: rect.top });
    panel.current.classList.add("is-resizing");
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = resize.current;
    if (!state || state.pointerId !== event.pointerId) return;
    state.latest = resizedPanelRect(
      state.startRect,
      state.direction,
      event.clientX - state.startX,
      event.clientY - state.startY,
      innerWidth,
      innerHeight,
    );
    applyPanelRect(state.latest);
  };

  const stopResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = resize.current;
    if (!state || state.pointerId !== event.pointerId) return;
    resize.current = null;
    panel.current?.classList.remove("is-resizing");
    setPanelPosition({ left: state.latest.left, top: state.latest.top });
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resizeWithKeyboard = (
    direction: ResizeDirection,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (!panel.current || innerWidth <= 600) return;
    const step = event.shiftKey ? 32 : 12,
      horizontal =
        event.key === "ArrowLeft"
          ? -step
          : event.key === "ArrowRight"
            ? step
            : 0,
      vertical =
        event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (!horizontal && !vertical) return;
    event.preventDefault();
    const rect = panel.current.getBoundingClientRect(),
      next = resizedPanelRect(
        {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        direction,
        horizontal,
        vertical,
        innerWidth,
        innerHeight,
      );
    applyPanelRect(next);
    setPanelPosition({ left: next.left, top: next.top });
  };

  return {
    panel,
    panelPosition,
    startDrag,
    moveDrag,
    stopDrag,
    startResize,
    moveResize,
    stopResize,
    resizeWithKeyboard,
  };
}
