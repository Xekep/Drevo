import { useCallback, useEffect, useRef } from "react";
import { useStore, type Viewport } from "@xyflow/react";
import { initialFamilyFocus } from "../../domain/tree-interactions.ts";
import type { Person } from "../../domain/types.ts";
import type { TreeGeometry, TreeMode } from "../../domain/tree-layout.ts";
import {
  TREE_NODE_HEIGHT,
  TREE_NODE_WIDTH,
} from "../../domain/tree-layout-constants.ts";

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

const MOBILE_MIN_CARD_WIDTH = 130;
const MOBILE_READABLE_ZOOM = MOBILE_MIN_CARD_WIDTH / TREE_NODE_WIDTH;

function initialTreePadding(width: number, height: number, narrow: boolean) {
  const shortSide = Math.min(width, height);
  if (narrow) return shortSide < 430 ? 0.12 : 0.16;
  if (shortSide < 700) return 0.16;
  if (shortSide < 1000) return 0.2;
  return 0.24;
}

function estimateWholeTreeZoom(
  positions: Map<string, { x: number; y: number }>,
  viewportWidth: number,
  viewportHeight: number,
  padding: number,
) {
  if (!positions.size) return 1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of positions.values()) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const treeWidth = Math.max(TREE_NODE_WIDTH, maxX - minX + TREE_NODE_WIDTH);
  const treeHeight = Math.max(TREE_NODE_HEIGHT, maxY - minY + TREE_NODE_HEIGHT);
  const paddingFactor = 1 + padding * 2;
  return Math.min(
    viewportWidth / treeWidth / paddingFactor,
    viewportHeight / treeHeight / paddingFactor,
  );
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
          const padding = initialTreePadding(canvasWidth, canvasHeight, narrow);
          const wholeTreeZoom = estimateWholeTreeZoom(
            positions,
            canvasWidth,
            canvasHeight,
            padding,
          );
          const useReadableFamilyFocus = narrow && wholeTreeZoom < MOBILE_READABLE_ZOOM;
          const initialNodes = useReadableFamilyFocus
            ? initialFamilyFocus(familyPeople)
                .filter((id) => positions.has(id))
                .map((id) => ({ id }))
            : undefined;

          // Сначала оцениваем весь фактический layout относительно текущего
          // viewport. Если всё дерево помещается на телефоне без превращения
          // карточек в микротекст, показываем его целиком. Если нет, fitView
          // стартует с ближайшей семьи и гарантирует читаемую ширину карточки.
          // На широком экране по-прежнему помещаем всё видимое древо.
          void flow.fitView({
            nodes: initialNodes?.length ? initialNodes : undefined,
            maxZoom: narrow ? 0.9 : 1,
            minZoom: useReadableFamilyFocus ? MOBILE_READABLE_ZOOM : 0.05,
            padding,
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
