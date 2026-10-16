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
  const source = useRef<{ x: number; y: number } | null>(null);
  const prepare = (id: string) => {
    const host = root.current, box = host?.getBoundingClientRect();
    const card = host && [...host.querySelectorAll<SVGGraphicsElement>("[data-depth-person]")]
      .find((node) => node.dataset.depthPerson === id);
    const rect = card?.getBoundingClientRect();
    source.current = rect && box ? { x: rect.left + rect.width / 2 - box.left,
      y: rect.top + rect.height / 2 - box.top } : null;
  };
  useLayoutEffect(() => {
    if (!ready) return;
    const key = enabled ? anchorId : "flat";
    const changed = previous.current && previous.current !== key;
    previous.current = key;
    if (
      !changed ||
      !enabled ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      source.current = null;
      return;
    }
    const plane = root.current?.querySelector<HTMLElement>(".tree-flow-plane");
    const host = root.current, box = host?.getBoundingClientRect();
    const card = host && [...host.querySelectorAll<HTMLElement>(".flow-person[data-person-id]")]
      .find((node) => node.dataset.personId === anchorId);
    const rect = card?.getBoundingClientRect();
    const dx = source.current && rect && box
      ? Math.max(-box.width * .65, Math.min(box.width * .65, source.current.x - (rect.left + rect.width / 2 - box.left))) : 0;
    const dy = source.current && rect && box
      ? Math.max(-box.height * .65, Math.min(box.height * .65, source.current.y - (rect.top + rect.height / 2 - box.top))) : 0;
    const direction = dx < 0 ? -1 : 1;
    source.current = null;
    const motion = plane?.animate(
      [
        {
          opacity: 0.66,
          transform: `perspective(1400px) translate3d(${dx}px, ${dy}px, -300px) rotateY(${direction * 14}deg) rotateX(5deg)`,
        },
        {
          offset: .6,
          opacity: .94,
          transform: `perspective(1400px) translate3d(${dx * .14}px, ${dy * .14}px, -45px) rotateY(${direction * 3}deg) rotateX(1deg)`,
        },
        {
          opacity: 1,
          transform: "perspective(1400px) translate3d(0, 0, 0) rotateY(0deg) rotateX(0deg)",
        },
      ],
      { duration: 620, easing: "cubic-bezier(.16,1,.3,1)" },
    );
    return () => motion?.cancel();
  }, [enabled, anchorId, ready, root]);
  return prepare;
}
