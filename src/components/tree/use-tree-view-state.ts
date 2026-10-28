import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { treeViewTransition, type TreeViewState } from "../../domain/tree-view-policy.ts";
import type { TreeMode } from "../../domain/tree-layout.ts";

/** Owns presentation transitions and the lifetime of a failed 3D attempt.
 * Family scope, geometry and camera retain their own existing owners. */
export function useTreeViewState(presentation?: "flat" | "depth") {
  const [state, dispatch] = useReducer(treeViewTransition, { kind: "canvas", mode: "generations" } as TreeViewState);
  const [failedPresentation, setFailedPresentation] = useState<"depth" | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [preparationPresentation, setPreparationPresentation] = useState(presentation);
  if (preparationPresentation !== presentation) {
    setPreparationPresentation(presentation);
    if (preparing) setPreparing(false);
  }
  const transition = useRef(0);
  useEffect(() => () => { transition.current++; }, []);
  const invalidatePreparation = useCallback(() => {
    transition.current++;
    setPreparing(false);
  }, []);
  // A preference change is a newer explicit view choice too. Run before the
  // canvas consumes a prepared intent from the former presentation.
  useLayoutEffect(() => { transition.current++; }, [presentation]);
  const prepare = useCallback(async (ensure: (() => Promise<void>) | undefined,
    commit: (isCurrent: () => boolean) => void, onError: (error: unknown) => void) => {
    const token = ++transition.current;
    const isCurrent = () => transition.current === token;
    if (!ensure) {
      setPreparing(false);
      commit(isCurrent);
      return;
    }
    setPreparing(true);
    try {
      await ensure?.();
      if (isCurrent()) commit(isCurrent);
    } catch (error) {
      if (transition.current === token) onError(error);
    } finally {
      if (transition.current === token) setPreparing(false);
    }
  }, []);
  // Leaving depth permits a deliberate later retry. No effect/one-frame stale
  // fallback is needed when preferences change before the next mode render.
  if (presentation !== "depth" && failedPresentation) setFailedPresentation(null);
  const setMode = useCallback((mode: TreeMode) => {
    invalidatePreparation();
    dispatch({ type: "mode", mode });
  }, [invalidatePreparation]);
  const setFanAnchor = useCallback((anchorId: string | null) => {
    invalidatePreparation();
    dispatch({ type: "fan", anchorId });
  }, [invalidatePreparation]);
  const reanchorFan = useCallback((anchorId: string, previousAnchor: string) =>
    dispatch({ type: "reanchor-fan", anchorId, previousAnchor }), []);
  const onDepthUnavailable = useCallback(() => {
    invalidatePreparation();
    setFailedPresentation("depth");
  }, [invalidatePreparation]);
  return {
    mode: state.mode,
    fanAnchor: state.kind === "fan" ? state.anchorId : null,
    depthUnavailable: failedPresentation !== null,
    setMode, setFanAnchor, reanchorFan, onDepthUnavailable, preparing, prepare,
  };
}
