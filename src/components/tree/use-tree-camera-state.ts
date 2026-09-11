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
  layoutKey: string;
  context: string;
  root: string | null;
  familyPeople: Person[];
  childrenCount: Map<string, number>;
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
};

type PendingAnchor = {
  id: string;
  personId: string;
  layoutKey: string;
  x: number;
  y: number;
  zoom: number;
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
  layoutKey,
  context,
  root,
  familyPeople,
  childrenCount,
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
  const pendingAnchor = useRef<PendingAnchor | null>(null);

  const captureAnchor = useCallback(
    (id: string, personId: string) => {
      const point = positions.get(id);
      if (!point) return;
      const camera = flow.getViewport();
      pendingAnchor.current = {
        id,
        personId,
        layoutKey,
        x: point.x * camera.zoom + camera.x,
        y: point.y * camera.zoom + camera.y,
        zoom: camera.zoom,
      };
    },
    [positions, flow, layoutKey],
  );

  const rememberContext = useCallback(() => {
    cameras.current[context] = flow.getViewport();
    pendingAnchor.current = null;
  }, [context, flow]);

  const resetContext = useCallback(() => {
    previousContext.current = "";
    pendingAnchor.current = null;
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
      const anchor = pendingAnchor.current;
      pendingAnchor.current = null;
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
      } else if (
        anchor &&
        anchor.layoutKey !== layoutKey &&
        !changedContext &&
        (positions.has(anchor.id) || positions.has(anchor.personId))
      ) {
        const point = (positions.get(anchor.id) ||
          positions.get(anchor.personId))!;
        void flow.setViewport({
          x: anchor.x - point.x * anchor.zoom,
          y: anchor.y - point.y * anchor.zoom,
          zoom: anchor.zoom,
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
        else
          void flow.fitView({
            maxZoom: 1,
            minZoom: 0.05,
            padding: 0.25,
          });
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
    childrenCount,
    peopleMap,
    ready,
    layoutKey,
    context,
    root,
    expanded,
    collapsed,
  ]);

  return {
    captureAnchor,
    rememberContext,
    resetContext,
    rememberViewport,
  };
}
