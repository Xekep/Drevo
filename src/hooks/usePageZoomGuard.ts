import { useEffect } from "react";

/** Keep pinch/trackpad gestures in content viewers, never in the page chrome. */
export function usePageZoomGuard() {
  useEffect(() => {
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) event.preventDefault();
    };
    const touch = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    };
    const gesture = (event: Event) => event.preventDefault();
    const options = { passive: false };
    window.addEventListener("wheel", wheel, options);
    window.addEventListener("touchmove", touch, options);
    window.addEventListener("gesturestart", gesture, options);
    window.addEventListener("gesturechange", gesture, options);
    return () => {
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("touchmove", touch);
      window.removeEventListener("gesturestart", gesture);
      window.removeEventListener("gesturechange", gesture);
    };
  }, []);
}
