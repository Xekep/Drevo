import { useCallback, useReducer } from "react";
import {
  canRestoreFanView,
  treeCameraNavigation,
  type BranchNavigationAnchor,
  type CameraNavigationState,
  type FamilyProjectionMode,
  type FanReturnView,
} from "../../domain/tree-camera-navigation.ts";
import type { TreeMode } from "../../domain/tree-layout.ts";

/** Own all pending camera requests and the fan return snapshot in one lifecycle. */
export function useTreeCameraNavigation(scope: string) {
  const [state, dispatch] = useReducer(treeCameraNavigation, {
    scope,
    sequence: 0,
    request: null,
    fanEntry: null,
  } as CameraNavigationState);
  // Access changes invalidate snapshots before this render can commit a camera effect.
  if (state.scope !== scope) dispatch({ type: "scope", scope });
  const request = state.scope === scope ? state.request : null;
  const fanEntry = state.scope === scope ? state.fanEntry : null;
  const returnToPerson = useCallback((id?: string | null) => {
    if (id) dispatch({ type: "person", id });
  }, []);
  const captureBranch = useCallback(
    (anchor: BranchNavigationAnchor) => dispatch({ type: "branch", anchor }),
    [],
  );
  const clearReturnTarget = useCallback(
    (token?: number) => dispatch({ type: "clear", kind: "person", token }),
    [],
  );
  const clearRestoreViewport = useCallback(
    (token?: number) => dispatch({ type: "clear", kind: "restore", token }),
    [],
  );
  const clearBranchAnchor = useCallback(
    () => dispatch({ type: "clear", kind: "branch" }),
    [],
  );
  const clearNavigation = useCallback(() => dispatch({ type: "clear" }), []);
  const rememberFanReturn = useCallback(
    (entry: FanReturnView) => dispatch({ type: "enter-fan", entry }),
    [],
  );
  const clearFanReturn = useCallback(() => dispatch({ type: "clear-fan" }), []);
  const leaveFan = useCallback(
    (
      targetId: string | null,
      mode: TreeMode,
      familyMode: FamilyProjectionMode,
    ) => dispatch({ type: "leave-fan", targetId, mode, familyMode }),
    [],
  );
  const canRestoreFan = useCallback(
    (
      targetId: string | null,
      mode: TreeMode,
      familyMode: FamilyProjectionMode,
    ) => canRestoreFanView(fanEntry, targetId, mode, familyMode),
    [fanEntry],
  );
  return {
    branchAnchor: request?.kind === "branch" ? request : null,
    returnTarget: request?.kind === "person" ? request : null,
    restoreViewport: request?.kind === "restore" ? request : null,
    returnToPerson,
    captureBranch,
    clearReturnTarget,
    clearRestoreViewport,
    clearBranchAnchor,
    clearNavigation,
    rememberFanReturn,
    clearFanReturn,
    leaveFan,
    canRestoreFan,
  };
}
