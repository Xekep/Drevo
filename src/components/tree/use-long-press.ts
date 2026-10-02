import { useEffect, useRef, type PointerEvent } from "react";

type Press = {
  pointerId: number;
  x: number;
  y: number;
  fired: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

export function useLongPress<T extends HTMLElement = HTMLButtonElement>(onLongPress: () => void) {
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);

  function clearPress() {
    if (!press.current) return;
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current = null;
  }
  function cancelPress() {
    clearPress();
    suppressClick.current = false;
  }

  useEffect(
    () => () => {
      if (press.current?.timer) clearTimeout(press.current.timer);
    },
    [],
  );

  return {
    suppressClick,
    cancel: cancelPress,
    active: () => !!press.current,
    handlers: {
      onPointerDown(event: PointerEvent<T>) {
        // A new pointer sequence cannot inherit the previous gesture's click.
        // A second touch also cancels a pending single-finger long press.
        cancelPress();
        if (
          event.pointerType !== "touch" ||
          !event.isPrimary ||
          event.button !== 0 ||
          !window.matchMedia("(max-width: 899px)").matches
        )
          return;
        const current: Press = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          fired: false,
        };
        current.timer = setTimeout(() => {
          if (press.current !== current) return;
          current.fired = true;
          suppressClick.current = true;
          onLongPress();
        }, 520);
        press.current = current;
      },
      onPointerMove(event: PointerEvent<T>) {
        const current = press.current;
        if (!current || current.pointerId !== event.pointerId || current.fired)
          return;
        if (
          Math.hypot(event.clientX - current.x, event.clientY - current.y) > 12
        )
          clearPress();
      },
      onPointerUp(event: PointerEvent<T>) {
        const current = press.current;
        if (!current || current.pointerId !== event.pointerId) return;
        clearPress();
        // The synthetic click comes after pointerup. Keep it suppressed until
        // the button consumes it (or until the next independent press).
      },
      onPointerCancel: cancelPress,
      onLostPointerCapture: clearPress,
    },
  };
}
