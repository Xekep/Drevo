import { useMemo, useState } from "react";
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
    sceneAnchorId: "",
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
    (enabled &&
      (navigation.anchorId !== anchorId ||
        (!!anchorId && !available.has(navigation.sceneAnchorId))))
  )
    setNavigation({
      ...navigation,
      active: enabled,
      anchorId,
      sceneAnchorId:
        !navigation.active || !available.has(navigation.sceneAnchorId)
          ? anchorId
          : navigation.sceneAnchorId,
      focusToken: focus?.token ?? -1,
    });
  const projection = useMemo(
    () =>
      enabled
        ? treeDepthBranches(family, available, anchorId)
        : { front: available, back: [] },
    [family, available, anchorId, enabled],
  );
  const sceneAnchorId = navigation.sceneAnchorId || anchorId;
  const scene = useMemo(
    () =>
      enabled ? treeDepthBranches(family, available, sceneAnchorId) : null,
    [family, available, sceneAnchorId, enabled],
  );
  const history = navigation.history.filter(
    (id) => available.has(id) && id !== anchorId,
  );
  return {
    ...projection,
    branches: scene?.back || [],
    sceneAnchorId,
    anchorId,
    previous: history.at(-1),
    choose(id: string, backwards = false) {
      if (!available.has(id) || id === anchorId) return false;
      setNavigation({
        ...navigation,
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
