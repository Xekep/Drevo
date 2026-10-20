import { useMemo, useState } from "react";
import type { Family } from "../../domain/types";
import { familyNeighbors } from "../../domain/family-neighborhood";
import {
  DEFAULT_FRAGMENT_THRESHOLD,
  treeFragment,
  type FragmentContinuation,
} from "../../domain/tree-fragment";
import type { TreeGenerationLimits } from "../../domain/tree-preferences";
import type { TreeFocus } from "./tree-canvas";

/** Owns only the automatic projection, never stored family data or the camera. */
export function useTreeFragment({
  family,
  allowed,
  preferredAnchor,
  limits,
  threshold,
  enabled,
  scopeKey,
  focus,
}: {
  family: Family;
  allowed: ReadonlySet<string>;
  preferredAnchor?: string;
  limits?: TreeGenerationLimits | null;
  threshold?: number;
  enabled: boolean;
  scopeKey: string;
  focus: TreeFocus | null;
}) {
  const activation = threshold ?? DEFAULT_FRAGMENT_THRESHOLD;
  const key = `${scopeKey}:${activation}:${JSON.stringify(limits || null)}`;
  const [navigation, setNavigation] = useState({
    key,
    anchorId: "",
    expanded: new Set<string>(),
    full: false,
    focusToken: -1,
    moveToken: 0,
  });
  const current =
    navigation.key === key
      ? navigation
      : {
          key,
          anchorId: "",
          expanded: new Set<string>(),
          full: false,
          focusToken: focus?.token ?? -1,
          moveToken: 0,
        };
  if (navigation.key !== key) setNavigation(current);
  const anchorId = allowed.has(current.anchorId)
    ? current.anchorId
    : preferredAnchor && allowed.has(preferredAnchor)
      ? preferredAnchor
      : allowed.values().next().value || "";
  const active =
    enabled &&
    activation > 0 &&
    family.people.length >= activation &&
    !current.full &&
    !!anchorId;
  const index = useMemo(() => familyNeighbors(family), [family]);
  const projection = useMemo(
    () =>
      active
        ? treeFragment(
            index,
            allowed,
            {
              ancestors: 3,
              descendants: 3,
              collateral: 1,
              ...limits,
              anchorId,
            },
            current.expanded,
          )
        : null,
    [active, index, allowed, limits, anchorId, current.expanded],
  );
  // An explicit locate can change the fragment. Opening a profile cannot.
  if (
    active &&
    focus &&
    focus.token !== current.focusToken &&
    focus.ids.length === 1 &&
    allowed.has(focus.ids[0])
  ) {
    setNavigation({
      ...current,
      focusToken: focus.token,
      moveToken: 0,
      ...(projection?.visible.has(focus.ids[0])
        ? {}
        : { anchorId: focus.ids[0], expanded: new Set<string>() }),
    });
  }
  return {
    active,
    anchorId,
    index,
    visible: projection?.visible || allowed,
    hidden: projection?.hidden || new Map<string, number>(),
    continuations:
      projection?.continuations || new Map<string, FragmentContinuation>(),
    atLimit: projection?.atLimit || false,
    expanded: current.expanded,
    focus:
      active && current.moveToken
        ? { ids: [anchorId], token: current.moveToken }
        : null,
    expand(id: string) {
      if (
        !projection ||
        !projection.visible.has(id) ||
        (projection.atLimit && !current.expanded.has(id))
      )
        return;
      const expanded = new Set(current.expanded);
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      setNavigation({ ...current, anchorId, expanded });
    },
    choose(id: string) {
      if (!allowed.has(id)) return;
      setNavigation({
        ...current,
        anchorId: id,
        expanded: new Set(),
        full: false,
        focusToken: focus?.token ?? -1,
        moveToken: Math.max(Date.now(), current.moveToken + 1),
      });
    },
    showAll() {
      setNavigation({ ...current, full: true });
    },
  };
}
