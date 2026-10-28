import type { TreeMode } from "./tree-layout.ts";

/** A fan is an explicit overlay with a remembered return mode. Keeping these
 * states together makes mode changes atomic instead of coordinating setters. */
export type TreeViewState =
  | { kind: "canvas"; mode: TreeMode }
  | { kind: "fan"; mode: TreeMode; anchorId: string };
export type TreeViewAction =
  | { type: "mode"; mode: TreeMode }
  | { type: "fan"; anchorId: string | null }
  | { type: "reanchor-fan"; anchorId: string; previousAnchor: string };

export function treeViewTransition(state: TreeViewState, action: TreeViewAction): TreeViewState {
  if (action.type === "mode") return { kind: "canvas", mode: action.mode };
  if (action.type === "reanchor-fan") return state.kind === "fan" && state.anchorId === action.previousAnchor
    ? { ...state, anchorId: action.anchorId } : state;
  return action.anchorId
    ? { kind: "fan", mode: state.mode, anchorId: action.anchorId }
    : { kind: "canvas", mode: state.mode };
}

/** The priority and capabilities of a projection live here, not in separate
 * conditions for toolbar, fragment, camera, gestures and render layers. */
export function treeViewPresentation(input: {
  mode: TreeMode;
  fanAnchor: string | null;
  presentation?: "flat" | "depth";
  depthUnavailable: boolean;
}) {
  const kind: "fan" | "timeline" | "depth" | "tree" = input.fanAnchor ? "fan"
    : input.mode === "timeline" ? "timeline"
    : input.presentation === "depth" && !input.depthUnavailable ? "depth" : "tree";
  return {
    kind,
    depthEnabled: kind === "depth",
    timelineActive: kind === "timeline",
    flatTree: kind === "tree",
  };
}

export function treeViewPolicy(input: ReturnType<typeof treeViewPresentation> & {
  familyMode: "all" | "family" | "common";
  replacingFilter: boolean;
  preview: boolean;
}) {
  return {
    ...input,
    fragmentEnabled: (input.flatTree || input.depthEnabled) && input.familyMode === "all" &&
      !input.replacingFilter && !input.preview,
  };
}
