import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Family } from "../../domain/types";
import { treeDepthBranches } from "../../domain/tree-depth";

export function useDepthTree(
  family: Family,
  available: ReadonlySet<string>,
  enabled: boolean,
  preferred: string | undefined,
  focus: { ids: string[]; token: number } | null,
) {
  const [navigation, setNavigation] = useState({
    anchorId: "",
    active: false,
    focusToken: -1,
    history: [] as string[],
  });
  const requested =
    focus?.ids.length === 1 && focus.token !== navigation.focusToken
      ? focus.ids[0]
      : enabled && !navigation.active
        ? preferred || ""
        : navigation.anchorId;
  const anchorId = available.has(requested)
    ? requested
    : preferred && available.has(preferred)
      ? preferred
      : available.values().next().value || "";
  // Latch the initial choice. Opening a profile is not a request to change planes.
  if (
    navigation.active !== enabled ||
    (enabled && navigation.anchorId !== anchorId)
  )
    setNavigation({
      ...navigation,
      active: enabled,
      anchorId,
      focusToken: focus?.token ?? -1,
    });
  const projection = useMemo(
    () =>
      enabled
        ? treeDepthBranches(family, available, anchorId)
        : { front: available, back: [] },
    [family, available, anchorId, enabled],
  );
  const history = navigation.history.filter((id) => available.has(id) && id !== anchorId);
  return {
    ...projection,
    anchorId,
    previous: history.at(-1),
    choose(id: string, backwards = false) {
      if (!available.has(id) || id === anchorId) return false;
      setNavigation({
        anchorId: id,
        active: enabled,
        focusToken: focus?.token ?? -1,
        history: backwards
          ? history.slice(0, -1)
          : [...history, anchorId].slice(-24),
      });
      return true;
    },
  };
}

/** Animate the plane, never the card or React Flow's camera transform. */
export function useDepthPlaneMotion(
  root: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  anchorId: string,
  ready: boolean,
) {
  const previous = useRef("");
  useLayoutEffect(() => {
    if (!ready) return;
    const key = enabled ? anchorId : "flat";
    const changed = previous.current && previous.current !== key;
    previous.current = key;
    if (
      !changed ||
      !enabled ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const plane = root.current?.querySelector<HTMLElement>(".tree-flow-plane");
    const motion = plane?.animate(
      [
        {
          opacity: 0.65,
          transform: "perspective(1400px) translateZ(-65px) translateY(-14px)",
        },
        {
          opacity: 1,
          transform: "perspective(1400px) translateZ(0) translateY(0)",
        },
      ],
      { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
    return () => motion?.cancel();
  }, [enabled, anchorId, ready, root]);
}
