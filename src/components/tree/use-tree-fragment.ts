import { useCallback, useEffect, useMemo, useState } from "react";
import type { Family } from "../../domain/types";
import { familyNeighbors } from "../../domain/family-neighborhood";
import {
  DEFAULT_FRAGMENT_THRESHOLD,
  FRAGMENT_PEOPLE_LIMIT,
  fragmentContinuationWindow,
  treeFragment,
  fragmentHiddenCounts,
} from "../../domain/tree-fragment";
import type { TreeGenerationLimits } from "../../domain/tree-preferences";
import type { TreeFocus } from "./tree-canvas";
import type { RemoteTreeFragment, TreeFragmentRequest } from "../../shared/tree-fragment";
import { assistantVisiblePeople, type AssistantTreeFilter } from "../../domain/research-tree-view";

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
  remoteFragment,
  filter,
}: {
  family: Family;
  allowed: ReadonlySet<string>;
  preferredAnchor?: string;
  limits?: TreeGenerationLimits | null;
  threshold?: number;
  enabled: boolean;
  scopeKey: string;
  focus: TreeFocus | null;
  remoteFragment?: RemoteTreeFragment;
  filter?: AssistantTreeFilter | null;
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
            priority: [],
            visited: new Set<string>(),
          },
    [navigation, key, focus?.token],
  );
  if (navigation.key !== key) setNavigation(current);
  const remoteState = remoteFragment?.state;
  const anchorId = remoteState && allowed.has(remoteState.anchorId) ? remoteState.anchorId : allowed.has(current.anchorId)
    ? current.anchorId
    : preferredAnchor && allowed.has(preferredAnchor)
      ? preferredAnchor
      : allowed.values().next().value || "";
  const active =
    enabled &&
    activation > 0 &&
    (remoteFragment?.state ? remoteFragment.state.total : family.people.length) >= activation &&
    !current.full &&
    !!anchorId;
  const index = useMemo(() => familyNeighbors(family), [family]);
  const projection = useMemo(
    () =>
      active && remoteState
        ? { visible: new Set(remoteState.peopleIds.filter(id => allowed.has(id))),
            hidden: remoteFragment?.graphComplete
              ? fragmentHiddenCounts(index, new Set(remoteState.peopleIds), assistantVisiblePeople(family.people, allowed, filter))
              : new Map(remoteState.hidden.filter(([id]) => allowed.has(id))),
            continuations: new Map(), atLimit: remoteState.atLimit }
        : active
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
      remoteState,
      remoteFragment?.graphComplete, family.people, filter,
    ],
  );
  // An explicit locate can change the fragment. Opening a profile cannot.
  if (
    active &&
    !remoteState &&
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
  const remoteLoad = remoteFragment?.load;
  useEffect(() => {
    if (!active || !remoteState || !remoteLoad) return;
    const desired = { ancestors: limits?.ancestors ?? 3, descendants: limits?.descendants ?? 3,
      collateral: limits?.collateral ?? 1 } as const;
    if (!remoteState.stale && desired.ancestors === remoteState.ancestors && desired.descendants === remoteState.descendants &&
        desired.collateral === remoteState.collateral && (!limits?.anchorId || limits.anchorId === remoteState.anchorId)) return;
    void remoteLoad({ ...desired, anchorId: limits?.anchorId || remoteState.anchorId, expanded: remoteState.expanded,
      offset: remoteState.offset }).catch(() => {});
  }, [active, remoteState, remoteLoad, limits]);
  useEffect(() => {
    if (!active || !remoteState || !remoteLoad || !focus || focus.ids.length !== 1 || focus.token === current.focusToken) return;
    const id = focus.ids[0];
    let pending = true;
    queueMicrotask(() => {
      if (!pending) return;
      setNavigation(previous => ({ ...previous, focusToken: focus.token }));
      if (remoteState.peopleIds.includes(id)) return;
      void remoteLoad({ anchorId: id, ancestors: remoteState.ancestors, descendants: remoteState.descendants,
        collateral: remoteState.collateral }).catch(() => {});
    });
    return () => { pending = false; };
  }, [active, remoteState, remoteLoad, focus, current.focusToken]);
  const expand = useCallback(
    (id: string) => {
      if (!projection?.visible.has(id)) return;
      if (remoteState && remoteLoad) {
        const expanded = new Set(remoteState.expanded);
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        const request: TreeFragmentRequest = {
          anchorId: projection.atLimit ? id : remoteState.anchorId,
          ancestors: remoteState.ancestors, descendants: remoteState.descendants, collateral: remoteState.collateral,
          expanded: projection.atLimit ? [] : [...expanded],
          ...(projection.atLimit ? { previous: remoteState.peopleIds,
            offset: id === remoteState.anchorId ? remoteState.nextOffset : 0 } : {}),
        };
        void remoteLoad(request).then(() => {
          if (projection.atLimit) setNavigation(previous => ({ ...previous, anchorId: id,
            moveToken: Math.max(Date.now(), previous.moveToken + 1) }));
        }).catch(() => {});
        return;
      }
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
        });
        return;
      }
      const expanded = new Set(current.expanded);
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      setNavigation({ ...current, anchorId, expanded });
    },
    [projection, current, anchorId, remoteState, remoteLoad],
  );
  return {
    active,
    anchorId: active && remoteState ? remoteState.anchorId : anchorId,
    index,
    visible: projection?.visible || allowed,
    hidden: projection?.hidden || new Map<string, number>(),
    expanded: remoteState && active ? new Set(remoteState.expanded) : current.expanded,
    focus:
      active && current.moveToken
        ? { ids: [anchorId], token: current.moveToken }
        : null,
    expand,
    choose(id: string) {
      if (remoteState && remoteLoad) {
        void remoteLoad({ anchorId: id, ancestors: remoteState.ancestors, descendants: remoteState.descendants,
          collateral: remoteState.collateral }).then(() => setNavigation(previous => ({ ...previous, anchorId: id,
            full: false, moveToken: Math.max(Date.now(), previous.moveToken + 1) }))).catch(() => {});
        return;
      }
      if (!allowed.has(id)) return;
      setNavigation({
        ...current,
        anchorId: id,
        expanded: new Set(),
        full: false,
        focusToken: focus?.token ?? -1,
        moveToken: Math.max(Date.now(), current.moveToken + 1),
        priority: [],
        visited: new Set(),
      });
    },
    showAll() {
      if (remoteFragment && remoteState) {
        void remoteFragment.ensureOverview().then(() => setNavigation(previous => ({ ...previous, full: true }))).catch(() => {});
      } else setNavigation({ ...current, full: true });
    },
  };
}
