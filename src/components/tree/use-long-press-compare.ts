import { useEffect, useRef, type PointerEvent } from "react";

type Press = {
  pointerId: number;
  x: number;
  y: number;
  fired: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

export function useLongPressCompare(onLongPress: () => void) {
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);

  function clearPress() {
    if (!press.current) return;
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current = null;
  }

  useEffect(
    () => () => {
      if (press.current?.timer) clearTimeout(press.current.timer);
    },
    [],
  );

  return {
    suppressClick,
    active: () => !!press.current,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (
          event.pointerType !== "touch" ||
          !event.isPrimary ||
          event.button !== 0 ||
          !window.matchMedia("(max-width: 899px)").matches
        )
          return;
        clearPress();
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
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const current = press.current;
        if (!current || current.pointerId !== event.pointerId || current.fired)
          return;
        if (
          Math.hypot(event.clientX - current.x, event.clientY - current.y) > 12
        )
          clearPress();
      },
      onPointerUp(event: PointerEvent<HTMLButtonElement>) {
        const current = press.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const fired = current.fired;
        clearPress();
        if (fired)
          setTimeout(() => {
            suppressClick.current = false;
          }, 0);
      },
      onPointerCancel: clearPress,
      onLostPointerCapture: clearPress,
    },
  };
}
