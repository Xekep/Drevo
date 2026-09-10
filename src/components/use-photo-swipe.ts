import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";

// One track for touch and mouse; native vertical scrolling and pinch stay available.
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
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    time: number;
    width: number;
    touch: boolean;
    image: boolean;
  } | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

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
        if (target) onNavigate(target);
        setSettling(false);
        setOffset(0);
      },
      reduced ? 0 : 240,
    );
  }
  function navigate(direction: -1 | 1, width: number) {
    const target = direction < 0 ? previous : next;
    if (!locked && target) settle(target, direction, width);
  }
  function cancel() {
    if (!gesture.current) return;
    suppressed.current = true;
    settle();
  }
  return {
    offset,
    settling,
    navigate,
    handlers: {
      onPointerDown(e: PointerEvent<HTMLDivElement>) {
        if (!e.isPrimary) {
          cancel();
          return;
        }
        if (locked || timer.current || e.button !== 0) return;
        suppressed.current = false;
        if ((e.target as Element).closest("button, a, input")) return;
        gesture.current = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          time: performance.now(),
          width: e.currentTarget.clientWidth,
          touch: e.pointerType === "touch",
          image: !!(e.target as Element).closest(".tag-image"),
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove(e: PointerEvent<HTMLDivElement>) {
        const start = gesture.current;
        if (!start || start.id !== e.pointerId) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.abs(dy) > Math.max(10, Math.abs(dx))) {
          cancel();
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
        const start = gesture.current;
        if (!start || start.id !== e.pointerId) return;
        gesture.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
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
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
      onClickCapture(e: MouseEvent<HTMLDivElement>) {
        if (suppressed.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    },
  };
}
