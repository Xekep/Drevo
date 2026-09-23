import { useCallback, useEffect, useRef } from "react";
import { useStore, type Viewport } from "@xyflow/react";
import type { Person } from "../../domain/types.ts";
import type { TreeGeometry, TreeMode } from "../../domain/tree-layout.ts";

type CameraFlow = {
  getViewport: () => Viewport;
  getZoom: () => number;
  setViewport: (viewport: Viewport) => unknown;
  fitView: (options: {
    nodes?: { id: string }[];
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
  focus: { ids: string[]; token: number } | null;
  positions: Map<string, { x: number; y: number }>;
  selected: string[];
  narrow: boolean;
  peopleMap: Map<string, Person>;
  context: string;
  root: string | null;
  onInitialViewReady?: () => void;
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
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
  focus,
  positions,
  selected,
  narrow,
  peopleMap,
  context,
  root,
  onInitialViewReady,
  expanded,
  collapsed,
}: TreeCameraStateInput) {
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const cameras = useRef<Record<string, Viewport>>({});
  const lastFocus = useRef(-1);
  const previousContext = useRef("");
  const previousReverse = useRef(reverse);
  const mobileCamera = useRef("");
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
        const changedContext = previousContext.current !== context;
        const switchedMode =
          !!previousContext.current &&
          previousContext.current.split(":")[0] !== mode;
        const reverseChanged = previousReverse.current !== reverse;
        previousContext.current = context;
        previousReverse.current = reverse;
        if (
          focus &&
          focus.token !== lastFocus.current &&
          focus.ids.every((id) => positions.has(id))
        ) {
          lastFocus.current = focus.token;
          viewportUpdate = flow.fitView({
            nodes: focus.ids.map((id) => ({ id })),
            maxZoom: 1,
            minZoom: narrow ? 0.55 : 0.15,
            padding: 0.5,
            duration: window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? 0
              : 650,
            ease: (progress) => 1 - (1 - progress) ** 3,
          });
        } else if (changedContext || reverseChanged) {
          if ((switchedMode || reverseChanged) && selected.length)
            viewportUpdate = flow.fitView({
              nodes: selected.map((id) => ({ id })),
              maxZoom: 1,
              minZoom: narrow ? 0.55 : 0.15,
              padding: 0.4,
            });
          else if (root)
            viewportUpdate = flow.fitView({
              nodes: narrow
                ? [root, ...(peopleMap.get(root)?.spouses || [])]
                    .filter((id) => positions.has(id))
                    .map((id) => ({ id }))
                : undefined,
              maxZoom: 0.95,
              minZoom: narrow ? 0.55 : 0.25,
              padding: 0.28,
            });
          else if (cameras.current[context] && !reverseChanged)
            viewportUpdate = flow.setViewport(cameras.current[context]);
          else {
            const padding = initialTreePadding(
              canvasWidth,
              canvasHeight,
              narrow,
            );
            // На входе помещаем всё дерево, затем отдельно ведём камеру к человеку.
            viewportUpdate = flow.fitView({
              maxZoom: narrow ? 0.9 : 1,
              minZoom: 0.05,
              padding,
            });
          }
        } else if (narrow) {
          const key = `${selected.join(":")}:${canvasWidth}:${canvasHeight}`;
          if (mobileCamera.current !== key) {
            mobileCamera.current = key;
            if (!selected.length) return;
            viewportUpdate = flow.fitView({
              nodes: selected.map((id) => ({ id })),
              minZoom: 0.55,
              maxZoom: Math.max(0.65, Math.min(0.9, flow.getZoom())),
              padding: 0.18,
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
    focus,
    positions,
    selected,
    flow,
    narrow,
    canvasWidth,
    canvasHeight,
    peopleMap,
    ready,
    context,
    root,
    expanded,
    collapsed,
  ]);

  return {
    rememberContext,
    resetContext,
    rememberViewport,
  };
}
