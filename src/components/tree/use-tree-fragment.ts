import { useCallback, useMemo, useState } from "react";
import type { Family } from "../../domain/types";
import { familyNeighbors } from "../../domain/family-neighborhood";
import {
  DEFAULT_FRAGMENT_THRESHOLD,
  FRAGMENT_PEOPLE_LIMIT,
  fragmentContinuationWindow,
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
    ownerId: null as string | null,
    priority: [] as string[],
    visited: new Set<string>(),
  });
  const current = useMemo(
    () =>
      navigation.key === key
        ? navigation
        : {
            key,
            anchorId: "",
            expanded: new Set<string>(),
            full: false,
            focusToken: focus?.token ?? -1,
            moveToken: 0,
            ownerId: null,
            priority: [],
            visited: new Set<string>(),
          },
    [navigation, key, focus?.token],
  );
  if (navigation.key !== key) setNavigation(current);
  const setOwner = useCallback((ownerId: string | null) => {
    setNavigation((previous) => ({ ...previous, ownerId }));
  }, []);
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
            FRAGMENT_PEOPLE_LIMIT,
            current.priority,
          )
        : null,
    [
      active,
      index,
      allowed,
      limits,
      anchorId,
      current.expanded,
      current.priority,
    ],
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
        : {
            anchorId: focus.ids[0],
            expanded: new Set<string>(),
            priority: [],
            visited: new Set<string>(),
          }),
    });
  }
  const expand = useCallback(
    (id: string) => {
      if (!projection?.visible.has(id)) return;
      const continuation = projection.continuations.get(id);
      if (projection.atLimit && continuation) {
        const nextWindow = fragmentContinuationWindow(
          continuation,
          projection.visible,
          current.visited,
        );
        setNavigation({
          ...current,
          ...nextWindow,
          anchorId: id,
          expanded: new Set(),
          ownerId: null,
        });
        return;
      }
      const expanded = new Set(current.expanded);
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      setNavigation({ ...current, anchorId, expanded, ownerId: null });
    },
    [projection, current, anchorId],
  );
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
    ownerId: current.ownerId,
    setOwner,
    focus:
      active && current.moveToken
        ? { ids: [anchorId], token: current.moveToken }
        : null,
    expand,
    choose(id: string) {
      if (!allowed.has(id)) return;
      setNavigation({
        ...current,
        anchorId: id,
        expanded: new Set(),
        full: false,
        focusToken: focus?.token ?? -1,
        moveToken: Math.max(Date.now(), current.moveToken + 1),
        ownerId: null,
        priority: [],
        visited: new Set(),
      });
    },
    showAll() {
      setNavigation({ ...current, full: true, ownerId: null });
    },
  };
}
