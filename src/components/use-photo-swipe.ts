import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";

const MAX_ZOOM = 4;

type TouchPoint = { x: number; y: number; touch: boolean };

type SwipeGesture = {
  id: number;
  x: number;
  y: number;
  time: number;
  width: number;
  touch: boolean;
  image: boolean;
};

type PanGesture = {
  id: number;
  x: number;
  y: number;
  panX: number;
  panY: number;
};

type PinchGesture = {
  ids: [number, number];
  distance: number;
  scale: number;
  anchorX: number;
  anchorY: number;
  centerX: number;
  centerY: number;
};

export function usePhotoSwipe({
  previous,
  next,
  locked,
  onNavigate,
  onTap,
}: {
  previous?: string;
  next?: string;
  locked: boolean;
  onNavigate: (id: string) => void;
  onTap: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressed = useRef(false);
  const gesture = useRef<SwipeGesture | null>(null);
  const panGesture = useRef<PanGesture | null>(null);
  const pinchGesture = useRef<PinchGesture | null>(null);
  const pointers = useRef(new Map<number, TouchPoint>());
  const container = useRef<HTMLDivElement | null>(null);
  const scale = useRef(1);
  const pan = useRef({ x: 0, y: 0 });

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function zoomTarget(root = container.current) {
    return root?.querySelector<HTMLElement>(
      ".photo-slide-current .tag-image",
    );
  }

  function applyZoom(root = container.current) {
    const target = zoomTarget(root);
    if (!target) return;
    if (scale.current <= 1.001) {
      target.style.removeProperty("transform");
      target.style.removeProperty("transform-origin");
      return;
    }
    target.style.transformOrigin = "center center";
    target.style.transform = `translate3d(${pan.current.x}px, ${pan.current.y}px, 0) scale(${scale.current})`;
  }

  function clampPan(root: HTMLDivElement, nextScale: number, x: number, y: number) {
    const target = zoomTarget(root);
    if (!target) return { x: 0, y: 0 };
    const maxX = Math.max(0, (target.offsetWidth * (nextScale - 1)) / 2);
    const maxY = Math.max(0, (target.offsetHeight * (nextScale - 1)) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  }

  function setZoom(root: HTMLDivElement, nextScale: number, x: number, y: number) {
    const normalized = Math.max(1, Math.min(MAX_ZOOM, nextScale));
    if (normalized <= 1.01) {
      scale.current = 1;
      pan.current = { x: 0, y: 0 };
    } else {
      scale.current = normalized;
      pan.current = clampPan(root, normalized, x, y);
    }
    applyZoom(root);
  }

  function resetZoom() {
    scale.current = 1;
    pan.current = { x: 0, y: 0 };
    panGesture.current = null;
    pinchGesture.current = null;
    applyZoom();
  }

  function touchPoints() {
    return [...pointers.current.entries()].filter(([, point]) => point.touch);
  }

  function startPinch(root: HTMLDivElement) {
    const touches = touchPoints();
    if (touches.length < 2) return false;
    const [[id1, p1], [id2, p2]] = touches;
    const distance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (!distance) return false;
    const midpoint = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const rect = root.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    pinchGesture.current = {
      ids: [id1, id2],
      distance,
      scale: scale.current,
      anchorX: (midpoint.x - centerX - pan.current.x) / scale.current,
      anchorY: (midpoint.y - centerY - pan.current.y) / scale.current,
      centerX,
      centerY,
    };
    gesture.current = null;
    panGesture.current = null;
    suppressed.current = true;
    setOffset(0);
    return true;
  }

  function settle(target?: string, direction = 0, width = 0) {
    gesture.current = null;
    if (timer.current) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    setSettling(true);
    setOffset(target ? -direction * width : 0);
    timer.current = setTimeout(
      () => {
        timer.current = null;
        if (target) {
          resetZoom();
          onNavigate(target);
        }
        setSettling(false);
        setOffset(0);
      },
      reduced ? 0 : 240,
    );
  }

  function navigate(direction: -1 | 1, width: number) {
    const target = direction < 0 ? previous : next;
    if (!locked && target) {
      resetZoom();
      settle(target, direction, width);
    }
  }

  function cancelSwipe() {
    if (!gesture.current) return;
    suppressed.current = true;
    gesture.current = null;
    setOffset(0);
  }

  function release(root: HTMLDivElement, pointerId: number) {
    if (root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId);
  }

  function cancelPointer(pointerId: number) {
    pointers.current.delete(pointerId);
    if (pinchGesture.current?.ids.includes(pointerId)) pinchGesture.current = null;
    if (panGesture.current?.id === pointerId) panGesture.current = null;
    if (gesture.current?.id === pointerId) {
      gesture.current = null;
      setOffset(0);
    }
    suppressed.current = true;
  }

  return {
    offset,
    settling,
    navigate,
    handlers: {
      onPointerDown(e: PointerEvent<HTMLDivElement>) {
        if (locked || timer.current || e.button !== 0) return;
        if ((e.target as Element).closest("button, a, input")) return;
        container.current = e.currentTarget;
        pointers.current.set(e.pointerId, {
          x: e.clientX,
          y: e.clientY,
          touch: e.pointerType === "touch",
        });
        e.currentTarget.setPointerCapture(e.pointerId);

        if (e.pointerType === "touch" && touchPoints().length >= 2) {
          startPinch(e.currentTarget);
          return;
        }

        suppressed.current = false;
        const image = !!(e.target as Element).closest(".tag-image");
        if (e.pointerType === "touch" && image && scale.current > 1.01) {
          panGesture.current = {
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            panX: pan.current.x,
            panY: pan.current.y,
          };
          suppressed.current = true;
          return;
        }

        if (!e.isPrimary) return;
        gesture.current = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          time: performance.now(),
          width: e.currentTarget.clientWidth,
          touch: e.pointerType === "touch",
          image,
        };
      },
      onPointerMove(e: PointerEvent<HTMLDivElement>) {
        const tracked = pointers.current.get(e.pointerId);
        if (tracked) {
          tracked.x = e.clientX;
          tracked.y = e.clientY;
        }

        const pinch = pinchGesture.current;
        if (pinch) {
          const p1 = pointers.current.get(pinch.ids[0]);
          const p2 = pointers.current.get(pinch.ids[1]);
          if (!p1 || !p2) return;
          e.preventDefault();
          suppressed.current = true;
          const distance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          const midpoint = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          const nextScale = pinch.scale * (distance / pinch.distance);
          const normalized = Math.max(1, Math.min(MAX_ZOOM, nextScale));
          const nextPanX =
            midpoint.x - pinch.centerX - pinch.anchorX * normalized;
          const nextPanY =
            midpoint.y - pinch.centerY - pinch.anchorY * normalized;
          setZoom(e.currentTarget, normalized, nextPanX, nextPanY);
          return;
        }

        const panStart = panGesture.current;
        if (panStart && panStart.id === e.pointerId) {
          e.preventDefault();
          suppressed.current = true;
          setZoom(
            e.currentTarget,
            scale.current,
            panStart.panX + e.clientX - panStart.x,
            panStart.panY + e.clientY - panStart.y,
          );
          return;
        }

        const start = gesture.current;
        if (!start || start.id !== e.pointerId) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.abs(dy) > Math.max(10, Math.abs(dx))) {
          cancelSwipe();
          return;
        }
        if (Math.abs(dx) > 8) suppressed.current = true;
        const available = dx > 0 ? previous : next;
        setOffset(
          Math.max(
            -start.width,
            Math.min(start.width, dx * (available ? 1 : 0.22)),
          ),
        );
      },
      onPointerUp(e: PointerEvent<HTMLDivElement>) {
        const root = e.currentTarget;
        const wasPinching = !!pinchGesture.current;
        pointers.current.delete(e.pointerId);

        if (wasPinching) {
          suppressed.current = true;
          pinchGesture.current = null;
          release(root, e.pointerId);
          const remaining = touchPoints()[0];
          if (scale.current <= 1.01) resetZoom();
          else if (remaining) {
            const [id, point] = remaining;
            panGesture.current = {
              id,
              x: point.x,
              y: point.y,
              panX: pan.current.x,
              panY: pan.current.y,
            };
          }
          return;
        }

        const panStart = panGesture.current;
        if (panStart?.id === e.pointerId) {
          panGesture.current = null;
          suppressed.current = true;
          release(root, e.pointerId);
          return;
        }

        const start = gesture.current;
        if (!start || start.id !== e.pointerId) {
          release(root, e.pointerId);
          return;
        }
        gesture.current = null;
        release(root, e.pointerId);
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        const elapsed = performance.now() - start.time;
        if (Math.abs(dx) <= 8 && Math.abs(dy) <= 8 && !suppressed.current) {
          setOffset(0);
          if (start.touch && start.image && elapsed < 500) onTap();
          return;
        }
        suppressed.current = true;
        const threshold = Math.min(90, start.width * 0.22);
        const completed =
          Math.abs(dx) > Math.abs(dy) * 1.5 &&
          (Math.abs(dx) > threshold || (Math.abs(dx) > 30 && elapsed < 250));
        const direction = dx < 0 ? 1 : -1;
        settle(
          completed ? (direction < 0 ? previous : next) : undefined,
          direction,
          start.width,
        );
      },
      onPointerCancel(e: PointerEvent<HTMLDivElement>) {
        cancelPointer(e.pointerId);
      },
      onLostPointerCapture(e: PointerEvent<HTMLDivElement>) {
        if (pointers.current.has(e.pointerId)) cancelPointer(e.pointerId);
      },
      onClickCapture(e: MouseEvent<HTMLDivElement>) {
        if (suppressed.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    },
  };
}
