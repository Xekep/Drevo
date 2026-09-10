import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export function useTreeFullscreen(container: RefObject<HTMLDivElement | null>) {
  const [fullscreen, setFullscreen] = useState(false);
  const active = useRef(false);
  const native = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const marker = "drevoTreeFullscreen";
  const leave = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    setFullscreen(false);
    if (document.fullscreenElement === container.current)
      void document.exitFullscreen().catch(() => {});
    native.current = false;
    trigger.current?.focus();
  }, [container]);
  const exit = useCallback(() => {
    if (window.history.state?.[marker]) window.history.back();
    leave();
  }, [leave]);
  useEffect(() => {
    const back = () => leave();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && active.current) {
        event.preventDefault();
        event.stopPropagation();
        exit();
      }
    };
    const change = () => {
      if (document.fullscreenElement === container.current)
        native.current = true;
      else if (native.current) exit();
    };
    window.addEventListener("popstate", back);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("fullscreenchange", change);
    return () => {
      window.removeEventListener("popstate", back);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("fullscreenchange", change);
      if (active.current && window.history.state?.[marker]) {
        const state = { ...window.history.state };
        delete state[marker];
        window.history.replaceState(state, "");
      }
    };
  }, [container, exit, leave]);
  function enter() {
    if (active.current) return;
    trigger.current = document.activeElement as HTMLElement | null;
    window.history.pushState({ ...window.history.state, [marker]: true }, "");
    active.current = true;
    setFullscreen(true);
    // iPhone and browsers without Fullscreen API use the same fixed viewport.
    void container.current?.requestFullscreen?.().catch(() => {});
    container.current?.focus({ preventScroll: true });
  }
  return { fullscreen, enter, exit };
}
