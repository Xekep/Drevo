import { useCallback, useEffect, useRef } from "react";
import { useStore, type Viewport } from "@xyflow/react";
import { initialFamilyFocus } from "../../domain/tree-interactions.ts";
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
  familyPeople: Person[];
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
};

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
  familyPeople,
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
    const timer = setTimeout(() => {
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
        void flow.fitView({
          nodes: focus.ids.map((id) => ({ id })),
          maxZoom: 1,
          minZoom: narrow ? 0.55 : 0.15,
          padding: 0.5,
        });
      } else if (changedContext || reverseChanged) {
        if ((switchedMode || reverseChanged) && selected.length)
          void flow.fitView({
            nodes: selected.map((id) => ({ id })),
            maxZoom: 1,
            minZoom: narrow ? 0.55 : 0.15,
            padding: 0.4,
          });
        else if (root)
          void flow.fitView({
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
          void flow.setViewport(cameras.current[context]);
        else {
          const initialNodes = narrow
            ? initialFamilyFocus(familyPeople)
                .filter((id) => positions.has(id))
                .map((id) => ({ id }))
            : undefined;
          void flow.fitView({
            nodes: initialNodes?.length ? initialNodes : undefined,
            maxZoom: narrow ? 0.9 : 1,
            minZoom: narrow ? 0.65 : 0.05,
            padding: narrow ? 0.32 : 0.25,
          });
        }
      } else if (narrow) {
        const key = `${selected.join(":")}:${canvasWidth}:${canvasHeight}`;
        if (mobileCamera.current !== key) {
          mobileCamera.current = key;
          if (!selected.length) return;
          void flow.fitView({
            nodes: selected.map((id) => ({ id })),
            minZoom: 0.55,
            maxZoom: Math.max(0.65, Math.min(0.9, flow.getZoom())),
            padding: 0.18,
          });
        }
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [
    geometry,
    nodeCount,
    mode,
    reverse,
    familyPeople,
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
