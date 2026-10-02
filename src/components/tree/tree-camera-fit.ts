import { getViewportForBounds, type Rect, type Viewport } from "@xyflow/system";

type LayoutNode = {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
};

export type TreeFitOptions = {
  ids?: readonly string[];
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
  duration?: number;
  ease?: (progress: number) => number;
};
export type FitTree = (options?: TreeFitOptions) => Promise<boolean>;

type CameraFlow = {
  viewportInitialized: boolean;
  setViewport: (
    viewport: Viewport,
    options?: { duration?: number; ease?: (progress: number) => number },
  ) => Promise<boolean>;
};

/** Renderer-hidden and unmounted cards retain their authoritative layout boxes. */
export function treeFitBounds(
  nodes: readonly LayoutNode[],
  ids?: readonly string[],
  personOccurrences?: ReadonlyMap<string, readonly string[]>,
): Rect | null {
  const lookup = ids ? new Map(nodes.map((node) => [node.id, node])) : null;
  const requested = ids
    ? ids.flatMap((id) => {
        const node =
          lookup!.get(id) ||
          personOccurrences
            ?.get(id)
            ?.map((occurrence) => lookup!.get(occurrence))
            .find(Boolean);
        return node ? [node] : [];
      })
    : nodes;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const node of requested) {
    const { x, y } = node.position;
    const { width, height } = node;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !width ||
      !height ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    )
      continue;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  }
  return left === Infinity
    ? null
    : {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };
}

/** fitView queues DOM measurement; known layout bounds can position the camera directly. */
export async function fitTreeNodes(
  flow: CameraFlow,
  nodes: readonly LayoutNode[],
  canvas: { width: number; height: number },
  options: TreeFitOptions = {},
  personOccurrences?: ReadonlyMap<string, readonly string[]>,
): Promise<boolean> {
  if (!flow.viewportInitialized || canvas.width <= 0 || canvas.height <= 0)
    return false;
  const bounds = treeFitBounds(nodes, options.ids, personOccurrences);
  if (!bounds) return false;
  const viewport = getViewportForBounds(
    bounds,
    canvas.width,
    canvas.height,
    options.minZoom ?? 0.05,
    options.maxZoom ?? 1.8,
    options.padding ?? 0.1,
  );
  return flow.setViewport(viewport, {
    duration: options.duration,
    ease: options.ease,
  });
}
