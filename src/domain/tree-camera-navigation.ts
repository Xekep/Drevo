import type { TreeMode } from "./tree-layout.ts";

export type CameraViewport = { x: number; y: number; zoom: number };
export type FamilyProjectionMode = "all" | "family" | "common";
export type FanReturnView = {
  anchorId: string;
  mode: TreeMode;
  familyMode: FamilyProjectionMode;
  viewport: CameraViewport;
};
export type BranchNavigationAnchor = {
  personId: string;
  occurrenceId: string | null;
  position: { x: number; y: number };
  viewport: CameraViewport;
  layoutKey: string;
  context: string;
};
export type CameraNavigationRequest =
  | { kind: "person"; id: string; token: number }
  | { kind: "restore"; viewport: CameraViewport; token: number }
  | (BranchNavigationAnchor & { kind: "branch"; token: number });
export type CameraNavigationState = {
  scope: string;
  sequence: number;
  request: CameraNavigationRequest | null;
  fanEntry: FanReturnView | null;
};
export type CameraNavigationAction =
  | { type: "person"; id: string }
  | { type: "branch"; anchor: BranchNavigationAnchor }
  | { type: "clear"; kind?: CameraNavigationRequest["kind"]; token?: number }
  | { type: "enter-fan"; entry: FanReturnView }
  | { type: "clear-fan" }
  | { type: "scope"; scope: string }
  | {
      type: "leave-fan";
      targetId: string | null;
      mode: TreeMode;
      familyMode: FamilyProjectionMode;
    };

export function canRestoreFanView(
  entry: FanReturnView | null,
  targetId: string | null,
  mode: TreeMode,
  familyMode: FamilyProjectionMode,
) {
  return (
    !!entry &&
    entry.anchorId === targetId &&
    entry.mode === mode &&
    entry.familyMode === familyMode
  );
}

/** A newer explicit navigation owns the camera; late completion never clears it. */
export function treeCameraNavigation(
  state: CameraNavigationState,
  action: CameraNavigationAction,
): CameraNavigationState {
  if (action.type === "scope")
    return state.scope === action.scope
      ? state
      : {
          scope: action.scope,
          sequence: state.sequence + 1,
          request: null,
          fanEntry: null,
        };
  if (action.type === "clear") {
    if (
      !state.request ||
      (action.kind && state.request.kind !== action.kind) ||
      (action.token !== undefined && state.request.token !== action.token)
    )
      return state;
    return { ...state, request: null };
  }
  if (action.type === "enter-fan")
    return {
      ...state,
      fanEntry: { ...action.entry, viewport: { ...action.entry.viewport } },
      request: null,
    };
  if (action.type === "clear-fan")
    return state.fanEntry ? { ...state, fanEntry: null } : state;
  const token = state.sequence + 1;
  if (action.type === "person")
    return {
      ...state,
      sequence: token,
      request: { kind: "person", id: action.id, token },
    };
  if (action.type === "branch")
    return {
      ...state,
      sequence: token,
      request: {
        kind: "branch",
        ...action.anchor,
        position: { ...action.anchor.position },
        viewport: { ...action.anchor.viewport },
        token,
      },
    };
  const request: CameraNavigationRequest | null = canRestoreFanView(
    state.fanEntry,
    action.targetId,
    action.mode,
    action.familyMode,
  )
    ? { kind: "restore", viewport: state.fanEntry!.viewport, token }
    : action.targetId
      ? { kind: "person", id: action.targetId, token }
      : null;
  return { ...state, sequence: token, fanEntry: null, request };
}
