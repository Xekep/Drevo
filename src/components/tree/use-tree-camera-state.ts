import { useCallback, useEffect, useRef } from "react";
import { useStore, type Viewport } from "@xyflow/react";
import type { Person } from "../../domain/types.ts";
import {
  TREE_NODE_HEIGHT,
  TREE_NODE_WIDTH,
  type TreeGeometry,
  type TreeMode,
} from "../../domain/tree-layout.ts";

export const PERSON_FOCUS_ZOOM = 0.55;

type CameraFlow = {
  getViewport: () => Viewport;
  setCenter: (
    x: number,
    y: number,
    options?: {
      zoom?: number;
      duration?: number;
      ease?: (progress: number) => number;
    },
  ) => unknown;
  setViewport: (
    viewport: Viewport,
    options?: { duration?: number; ease?: (progress: number) => number },
  ) => unknown;
  fitView: (options: {
    nodes?: { id: string }[];
    includeHiddenNodes?: boolean;
    minZoom?: number;
    maxZoom?: number;
    padding?: number;
    duration?: number;
    ease?: (progress: number) => number;
  }) => unknown;
};

type TreeCameraStateInput = {
  flow: CameraFlow;
  geometry: TreeGeometry | null;
  nodeCount: number;
  mode: TreeMode;
  reverse: boolean;
  ready: boolean;
  focusReady: boolean;
  focus: { ids: string[]; token: number; purpose?: "family" } | null;
  returnPersonId: string | null;
  returnToken: number;
  restoreViewport: { viewport: Viewport; token: number } | null;
  onRestoreComplete?: () => void;
  personOccurrences: Map<string, string[]>;
  onReturnComplete?: () => void;
  positions: Map<string, { x: number; y: number }>;
  selected: string[];
  narrow: boolean;
  peopleMap: Map<string, Person>;
  context: string;
  root: string | null;
  initialPersonId: string | null;
  onInitialViewReady?: () => void;
  manualCameraOverride: boolean;
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  layoutKey: string;
  branchAnchor: {
    personId: string;
    occurrenceId: string | null;
    position: { x: number; y: number };
    viewport: Viewport;
    layoutKey: string;
    token: number;
  } | null;
};

function initialTreePadding(width: number, height: number, narrow: boolean) {
  const shortSide = Math.min(width, height);
  if (narrow) return shortSide < 430 ? 0.12 : 0.16;
  if (shortSide < 700) return 0.16;
  if (shortSide < 1000) return 0.2;
  return 0.24;
}

/** Сохраняет и восстанавливает viewport дерева, не вмешиваясь в расчёт геометрии. */
export function useTreeCameraState({
  flow,
  geometry,
  nodeCount,
  mode,
  reverse,
  ready,
  focusReady,
  focus,
  returnPersonId,
  returnToken,
  restoreViewport,
  onRestoreComplete,
  personOccurrences,
  onReturnComplete,
  positions,
  selected,
  narrow,
  peopleMap,
  context,
  root,
  initialPersonId,
  onInitialViewReady,
  manualCameraOverride,
  expanded,
  collapsed,
  layoutKey,
  branchAnchor,
}: TreeCameraStateInput) {
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const cameras = useRef<Record<string, Viewport>>({});
  const lastFocus = useRef(-1);
  // Открытие карточки меняет ширину полотна уже после запроса фокуса.
  const lastFocusCanvas = useRef<{ width: number; height: number } | null>(
    null,
  );
  const lastReturn = useRef(-1);
  const lastRestore = useRef(-1);
  const lastBranch = useRef(-1);
  const previousContext = useRef("");
  const previousReverse = useRef(reverse);
  const initialViewSent = useRef(false);
  const rememberContext = useCallback(() => {
    cameras.current[context] = flow.getViewport();
  }, [context, flow]);

  const resetContext = useCallback(() => {
    previousContext.current = "";
  }, []);

  const rememberViewport = useCallback(
    (camera: Viewport) => {
      cameras.current[context] = camera;
    },
    [context],
  );

  useEffect(() => {
    if (
      !geometry ||
      !nodeCount ||
      geometry.mode !== mode ||
      geometry.reverse !== reverse ||
      !ready ||
      !canvasWidth ||
      !canvasHeight
    )
      return;
    const timer = setTimeout(
      () => {
        let viewportUpdate: unknown;
        if (manualCameraOverride && !initialViewSent.current) {
          initialViewSent.current = true;
          previousContext.current = context;
          previousReverse.current = reverse;
          onInitialViewReady?.();
          return;
        }
        const changedContext = previousContext.current !== context;
        const motionEnabled = !window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        const contextDuration =
          initialViewSent.current && motionEnabled ? 520 : 0;
        const contextEase = (progress: number) => 1 - (1 - progress) ** 3;
        const switchedMode =
          !!previousContext.current &&
          previousContext.current.split(":")[0] !== mode;
        const reverseChanged = previousReverse.current !== reverse;
        previousContext.current = context;
        previousReverse.current = reverse;
        const returnOccurrence = returnPersonId
          ? personOccurrences
              .get(returnPersonId)
              ?.find((id) => positions.has(id))
          : undefined;
        if (restoreViewport && restoreViewport.token !== lastRestore.current) {
          lastRestore.current = restoreViewport.token;
          viewportUpdate = flow.setViewport(restoreViewport.viewport, {
            duration: 0,
          });
          void Promise.resolve(viewportUpdate).then(
            () => onRestoreComplete?.(),
            () => onRestoreComplete?.(),
          );
        } else if (returnPersonId && returnToken !== lastReturn.current) {
          if (!returnOccurrence) return;
          const target = positions.get(returnOccurrence);
          if (!target) return;
          lastReturn.current = returnToken;
          viewportUpdate = flow.setCenter(
            target.x + (geometry.nodeSize?.width ?? TREE_NODE_WIDTH) / 2,
            target.y + (geometry.nodeSize?.height ?? TREE_NODE_HEIGHT) / 2,
            {
              zoom: PERSON_FOCUS_ZOOM,
              duration: motionEnabled ? 560 : 0,
              ease: (progress) => 1 - (1 - progress) ** 3,
            },
          );
          void Promise.resolve(viewportUpdate).then(
            () => onReturnComplete?.(),
            () => onReturnComplete?.(),
          );
        } else if (
          branchAnchor &&
          branchAnchor.token !== lastBranch.current &&
          branchAnchor.layoutKey !== layoutKey
        ) {
          const occurrence =
            branchAnchor.occurrenceId &&
            positions.has(branchAnchor.occurrenceId)
              ? branchAnchor.occurrenceId
              : personOccurrences
                  .get(branchAnchor.personId)
                  ?.find((id) => positions.has(id));
          const target = occurrence ? positions.get(occurrence) : undefined;
          if (!target) return;
          lastBranch.current = branchAnchor.token;
          const { viewport, position } = branchAnchor;
          viewportUpdate = flow.setViewport(
            {
              x: viewport.x + (position.x - target.x) * viewport.zoom,
              y: viewport.y + (position.y - target.y) * viewport.zoom,
              zoom: viewport.zoom,
            },
            { duration: motionEnabled ? 440 : 0, ease: contextEase },
          );
        } else if (
          focusReady &&
          focus &&
          (focus.token !== lastFocus.current ||
            !lastFocusCanvas.current ||
            Math.abs(lastFocusCanvas.current.width - canvasWidth) > 2 ||
            Math.abs(lastFocusCanvas.current.height - canvasHeight) > 2) &&
          focus.ids.every((id) => positions.has(id))
        ) {
          lastFocus.current = focus.token;
          lastFocusCanvas.current = {
            width: canvasWidth,
            height: canvasHeight,
          };
          const target =
            focus.ids.length === 1 && focus.purpose !== "family"
              ? positions.get(focus.ids[0])
              : undefined;
          viewportUpdate = target
            ? flow.setCenter(
                target.x + (geometry.nodeSize?.width ?? TREE_NODE_WIDTH) / 2,
                target.y + (geometry.nodeSize?.height ?? TREE_NODE_HEIGHT) / 2,
                {
                  zoom: PERSON_FOCUS_ZOOM,
                  duration: motionEnabled ? 650 : 0,
                  ease: (progress) => 1 - (1 - progress) ** 3,
                },
              )
            : flow.fitView({
                nodes: focus.ids.map((id) => ({ id })),
                includeHiddenNodes: true,
                maxZoom: focus.purpose === "family" ? 0.95 : 1,
                minZoom:
                  focus.purpose === "family" ? 0.05 : narrow ? 0.55 : 0.15,
                padding: focus.purpose === "family" ? 0.34 : 0.5,
                duration: motionEnabled ? 650 : 0,
                ease: (progress) => 1 - (1 - progress) ** 3,
              });
        } else if (changedContext || reverseChanged) {
          const initialOccurrence =
            !initialViewSent.current && initialPersonId
              ? personOccurrences
                  .get(initialPersonId)
                  ?.find((id) => positions.has(id))
              : undefined;
          const initialPosition = initialOccurrence
            ? positions.get(initialOccurrence)
            : undefined;
          // Start near the person so a large archive never reveals tiny portraits.
          if (initialPosition)
            viewportUpdate = flow.setCenter(
              initialPosition.x +
                (geometry.nodeSize?.width ?? TREE_NODE_WIDTH) / 2,
              initialPosition.y +
                (geometry.nodeSize?.height ?? TREE_NODE_HEIGHT) / 2,
              { zoom: narrow ? PERSON_FOCUS_ZOOM : 0.42, duration: 0 },
            );
          else if (changedContext && context.includes(":research:"))
            viewportUpdate = flow.fitView({
              nodes: [...positions.keys()].map((id) => ({ id })),
              includeHiddenNodes: true,
              minZoom: 0.05,
              maxZoom: narrow ? 0.9 : 1,
              padding: 0.2,
              duration: contextDuration,
              ease: contextEase,
            });
          else if ((switchedMode || reverseChanged) && selected.length)
            viewportUpdate = flow.fitView({
              nodes: selected.map((id) => ({ id })),
              includeHiddenNodes: true,
              maxZoom: 1,
              minZoom: narrow ? 0.55 : 0.15,
              padding: 0.4,
              duration: contextDuration,
              ease: contextEase,
            });
          else if (root)
            viewportUpdate = flow.fitView({
              nodes: narrow
                ? [root, ...(peopleMap.get(root)?.spouses || [])]
                    .filter((id) => positions.has(id))
                    .map((id) => ({ id }))
                : [...positions.keys()].map((id) => ({ id })),
              includeHiddenNodes: true,
              maxZoom: 0.95,
              minZoom: narrow ? 0.55 : 0.25,
              padding: 0.28,
              duration: contextDuration,
              ease: contextEase,
            });
          else if (cameras.current[context] && !reverseChanged)
            viewportUpdate = flow.setViewport(cameras.current[context], {
              duration: contextDuration,
              ease: contextEase,
            });
          else {
            const padding = initialTreePadding(
              canvasWidth,
              canvasHeight,
              narrow,
            );
            // На входе помещаем всё дерево, затем отдельно ведём камеру к человеку.
            viewportUpdate = flow.fitView({
              nodes: [...positions.keys()].map((id) => ({ id })),
              includeHiddenNodes: true,
              maxZoom: narrow ? 0.9 : 1,
              minZoom: 0.05,
              padding,
              duration: contextDuration,
              ease: contextEase,
            });
          }
        }
        if (!initialViewSent.current) {
          initialViewSent.current = true;
          void Promise.resolve(viewportUpdate).then(
            () => onInitialViewReady?.(),
            () => onInitialViewReady?.(),
          );
        }
      },
      narrow ? 0 : 50,
    );
    return () => clearTimeout(timer);
  }, [
    geometry,
    nodeCount,
    mode,
    reverse,
    onInitialViewReady,
    manualCameraOverride,
    focus,
    returnPersonId,
    returnToken,
    restoreViewport,
    onRestoreComplete,
    personOccurrences,
    onReturnComplete,
    positions,
    selected,
    flow,
    narrow,
    canvasWidth,
    canvasHeight,
    peopleMap,
    ready,
    focusReady,
    context,
    root,
    initialPersonId,
    expanded,
    collapsed,
    layoutKey,
    branchAnchor,
  ]);

  return {
    rememberContext,
    resetContext,
    rememberViewport,
  };
}
