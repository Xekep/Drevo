import { useCallback, useMemo, useState } from "react";
import type { Family } from "../../domain/types";
import { visibleBranch } from "../../domain/tree-layout";
import { initialFamilyFocus } from "../../domain/tree-interactions";
import {
  familyNeighbors,
  familyNeighborhood,
  completeVisibleParents,
  commonAncestorNetwork,
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
    mode: "all" as "all" | "family" | "common",
    anchor: selected[0] || defaultAnchor,
    expanded: new Set<string>(),
    revealed: focus?.ids || [],
    focusToken: focus?.token,
  }));
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const newFocus = !!focus && focus.token !== view.focusToken;
  const requested = newFocus ? focus.ids[0] : view.anchor;
  const anchor =
    view.mode !== "all"
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
  const commonVisible = useMemo(() => {
    if (!anchor || view.mode !== "common") return new Set<string>();
    const blood = commonAncestorNetwork(index, anchor);
    const branch = visibleBranch(family, null, collapsed, [anchor]);
    return new Set([...blood].filter((id) => branch.has(id)));
  }, [anchor, view.mode, index, family, collapsed]);
  const neighborhood = useMemo(
    () =>
      anchor && view.mode === "family"
        ? familyNeighborhood(index, anchor, expanded, pinned)
        : anchor
          ? {
              visible: commonVisible,
              hidden: new Map<string, number>(),
            }
          : {
              visible: completeVisibleParents(
                index,
                visibleBranch(family, null, collapsed, pinned),
              ),
              hidden: new Map<string, number>(),
            },
    [
      anchor,
      view.mode,
      index,
      expanded,
      pinned,
      family,
      collapsed,
      commonVisible,
    ],
  );
  const enter = useCallback(
    (id = selected[0] || anchor || defaultAnchor) => {
      if (id && index.people.has(id)) {
        setView({
          mode: "family",
          anchor: id,
          expanded: new Set(),
          revealed: [],
          focusToken: focus?.token,
        });
      }
    },
    [selected, anchor, defaultAnchor, index, focus?.token],
  );
  const enterCommon = useCallback(
    (id = selected[0] || anchor || defaultAnchor) => {
      if (id && index.people.has(id)) {
        setCollapsed(new Set());
        setView({
          mode: "common",
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
      mode: "all",
      anchor,
      expanded: new Set(),
      revealed: [],
      focusToken: focus?.token,
    });
    setCollapsed(new Set());
  }, [anchor, focus?.token]);
  const toggle = useCallback(
    (id: string) => {
      if (anchor && view.mode === "family") {
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
          mode: "family",
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
    [
      anchor,
      view.mode,
      expanded,
      index,
      pinned,
      focus,
      newFocus,
      view.revealed,
    ],
  );
  const reset = useCallback(
    () =>
      view.mode === "family" && anchor
        ? enter(anchor)
        : setCollapsed(new Set()),
    [view.mode, anchor, enter],
  );
  return {
    mode: view.mode,
    anchor,
    ...neighborhood,
    expanded,
    collapsed,
    enter,
    enterCommon,
    showAll,
    toggle,
    reset,
    defaultAnchor,
  };
}
