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
    active: false,
    focusToken: -1,
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
  // Opening a profile does not implicitly select a new camera target.
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
  return {
    ...projection,
    anchorId,
    choose(id: string) {
      if (!available.has(id) || id === anchorId) return false;
      setNavigation({
        ...navigation,
        anchorId: id,
        active: enabled,
        focusToken: focus?.token ?? -1,
      });
      return true;
    },
  };
}
