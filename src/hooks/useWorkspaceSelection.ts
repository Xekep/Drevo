import { useCallback, useReducer } from "react";
import type { TreeFocus } from "../components/tree/tree-canvas";
type State = {
  selected: string[];
  compare: boolean;
  linkFrom: string | null;
  focus: TreeFocus | null;
  spotlight: string[];
};
type Action =
  | { type: "choose"; id: string; additive: boolean }
  | { type: "reveal"; ids: string[] }
  | { type: "revealFamily"; ids: string[] }
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
        linkFrom: null,
        spotlight: [],
      };
    case "compare":
      return {
        ...state,
        compare: true,
        selected: state.selected.slice(0, 1),
        linkFrom: null,
        spotlight: [],
      };
    case "link":
      return {
        ...state,
        linkFrom: state.selected[0] || "",
        compare: false,
        spotlight: [],
      };
    case "finishLink":
      return { ...state, linkFrom: null };
    case "reveal":
      return {
        ...state,
        selected: action.ids.slice(0, 2),
        compare: action.ids.length === 2,
        linkFrom: null,
        spotlight: [],
        focus: { ids: action.ids, token: (state.focus?.token || 0) + 1 },
      };
    case "revealFamily":
      return {
        ...state,
        selected: [],
        compare: false,
        linkFrom: null,
        spotlight: action.ids,
        focus: {
          ids: action.ids,
          token: (state.focus?.token || 0) + 1,
          purpose: "family",
        },
      };
    case "choose": {
      if (state.linkFrom === "")
        return {
          ...state,
          selected: [action.id],
          linkFrom: action.id,
          spotlight: [],
        };
      const comparison = state.compare || action.additive;
      const selected = comparison
        ? state.selected.includes(action.id)
          ? state.compare
            ? state.selected.filter((id) => id !== action.id)
            : state.selected
          : [...state.selected.slice(0, 1), action.id]
        : [action.id];
      return { ...state, selected, compare: comparison, spotlight: [] };
    }
  }
}
export function useWorkspaceSelection() {
  const [state, dispatch] = useReducer(reducer, {
    selected: [],
    compare: false,
    linkFrom: null,
    focus: null,
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
    (ids: string[]) => dispatch({ type: "revealFamily", ids }),
    [],
  );
  return { ...state, choose, reveal, revealFamily, dispatch };
}
