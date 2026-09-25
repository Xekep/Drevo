import { useCallback, useReducer } from "react";
import type { TreeFocus } from "../components/tree/tree-canvas";
type State = {
  selected: string[];
  compare: boolean;
  selectionOnly: boolean;
  linkFrom: string | null;
  focus: TreeFocus | null;
  focusSerial: number;
  spotlight: string[];
};
type Action =
  | { type: "choose"; id: string; additive: boolean }
  | { type: "selectOnly"; id: string }
  | { type: "reveal"; ids: string[] }
  | { type: "revealFamily"; ids: string[]; groupId: string }
  | { type: "compare" }
  | { type: "link" }
  | { type: "clear" }
  | { type: "finishLink" };
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "clear":
      return {
        ...state,
        selected: [],
        compare: false,
        selectionOnly: false,
        linkFrom: null,
        spotlight: [],
        focus: null,
      };
    case "compare":
      return {
        ...state,
        compare: true,
        selectionOnly: false,
        selected: state.selected.slice(0, 1),
        linkFrom: null,
        spotlight: [],
        focus: null,
      };
    case "link":
      return {
        ...state,
        linkFrom: state.selected[0] || "",
        compare: false,
        selectionOnly: false,
        spotlight: [],
        focus: null,
      };
    case "finishLink":
      return { ...state, linkFrom: null };
    case "reveal":
      return {
        ...state,
        selected: action.ids.slice(0, 2),
        compare: action.ids.length === 2,
        selectionOnly: false,
        linkFrom: null,
        spotlight: [],
        focusSerial: state.focusSerial + 1,
        focus: { ids: action.ids, token: state.focusSerial + 1 },
      };
    case "revealFamily":
      return {
        ...state,
        selected: [],
        compare: false,
        selectionOnly: false,
        linkFrom: null,
        spotlight: action.ids,
        focusSerial: state.focusSerial + 1,
        focus: {
          ids: action.ids,
          token: state.focusSerial + 1,
          purpose: "family",
          groupId: action.groupId,
        },
      };
    case "selectOnly":
      return {
        ...state,
        selected: [action.id],
        selectionOnly: true,
        compare: false,
        linkFrom: null,
        spotlight: [],
        focus: null,
      };
    case "choose": {
      if (state.linkFrom === "")
        return {
          ...state,
          selected: [action.id],
          selectionOnly: false,
          linkFrom: action.id,
          spotlight: [],
          focus: null,
        };
      const comparison = state.compare || action.additive;
      const selected = comparison
        ? state.selected.includes(action.id)
          ? state.compare
            ? state.selected.filter((id) => id !== action.id)
            : state.selected
          : [...state.selected.slice(0, 1), action.id]
        : [action.id];
      return {
        ...state,
        selected,
        compare: comparison,
        selectionOnly: false,
        spotlight: [],
        focus: null,
      };
    }
  }
}
export function useWorkspaceSelection() {
  const [state, dispatch] = useReducer(reducer, {
    selected: [],
    compare: false,
    selectionOnly: false,
    linkFrom: null,
    focus: null,
    focusSerial: 0,
    spotlight: [],
  });
  const choose = useCallback(
    (id: string, additive = false) =>
      dispatch({ type: "choose", id, additive }),
    [],
  );
  const reveal = useCallback(
    (ids: string[]) => dispatch({ type: "reveal", ids }),
    [],
  );
  const revealFamily = useCallback(
    (ids: string[], groupId: string) =>
      dispatch({ type: "revealFamily", ids, groupId }),
    [],
  );
  return { ...state, choose, reveal, revealFamily, dispatch };
}
