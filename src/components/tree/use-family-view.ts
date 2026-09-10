import { useCallback, useMemo, useState } from "react";
import type { Family } from "../../domain/types";
import { visibleBranch } from "../../domain/tree-layout";
import { initialFamilyFocus } from "../../domain/tree-interactions";
import {
  familyNeighbors,
  familyNeighborhood,
  completeVisibleParents,
} from "../../domain/family-neighborhood";
import type { TreeFocus } from "./tree-canvas";

export function useFamilyView(
  family: Family,
  selected: string[],
  highlighted: string[],
  focus: TreeFocus | null,
  preview: { from: string; to: string } | null,
) {
  const { people, links } = family;
  const index = useMemo(
    () => familyNeighbors({ people, links }),
    [people, links],
  );
  const defaultAnchor = useMemo(
    () => initialFamilyFocus(family.people)[0] || null,
    [family.people],
  );
  const [view, setView] = useState(() => ({
    family: family.people.length > 24,
    anchor: selected[0] || defaultAnchor,
    expanded: new Set<string>(),
    revealed: focus?.ids || [],
    focusToken: focus?.token,
  }));
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const newFocus = !!focus && focus.token !== view.focusToken;
  const requested = newFocus ? focus.ids[0] : view.anchor;
  const anchor = view.family
    ? requested && index.people.has(requested)
      ? requested
      : defaultAnchor
    : null;
  const expanded = useMemo(
    () => (newFocus ? new Set<string>() : view.expanded),
    [newFocus, view.expanded],
  );
  const pinned = useMemo(
    () => [
      ...new Set([
        ...selected,
        ...highlighted,
        ...(newFocus ? focus.ids : view.revealed),
        ...(preview ? [preview.from, preview.to] : []),
      ]),
    ],
    [selected, highlighted, preview, newFocus, focus, view.revealed],
  );
  const neighborhood = useMemo(
    () =>
      anchor
        ? familyNeighborhood(index, anchor, expanded, pinned)
        : {
            visible: completeVisibleParents(
              index,
              visibleBranch(family, null, collapsed, pinned),
            ),
            hidden: new Map<string, number>(),
          },
    [anchor, index, expanded, pinned, family, collapsed],
  );
  const enter = useCallback(
    (id = selected[0] || anchor || defaultAnchor) => {
      if (id && index.people.has(id)) {
        setView({
          family: true,
          anchor: id,
          expanded: new Set(),
          revealed: [],
          focusToken: focus?.token,
        });
      }
    },
    [selected, anchor, defaultAnchor, index, focus?.token],
  );
  const showAll = useCallback(() => {
    setView({
      family: false,
      anchor,
      expanded: new Set(),
      revealed: [],
      focusToken: focus?.token,
    });
    setCollapsed(new Set());
  }, [anchor, focus?.token]);
  const toggle = useCallback(
    (id: string) => {
      if (anchor) {
        const next = new Set(expanded);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        const available = familyNeighborhood(
          index,
          anchor,
          next,
          pinned,
        ).visible;
        setView({
          family: true,
          anchor,
          expanded: new Set([...next].filter((id) => available.has(id))),
          revealed: newFocus ? focus.ids : view.revealed,
          focusToken: focus?.token,
        });
      } else
        setCollapsed((value) => {
          const next = new Set(value);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
    },
    [anchor, expanded, index, pinned, focus, newFocus, view.revealed],
  );
  const reset = useCallback(
    () => (anchor ? enter(anchor) : setCollapsed(new Set())),
    [anchor, enter],
  );
  return {
    anchor,
    ...neighborhood,
    expanded,
    collapsed,
    enter,
    showAll,
    toggle,
    reset,
    defaultAnchor,
  };
}
