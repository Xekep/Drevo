import {
  spatialBranchLayout,
  type SpatialPoint,
} from "../../domain/spatial-branch-layout";
import type { DepthConnection } from "../../domain/tree-depth";

export type SpatialLayoutRequest = {
  requestId: number;
  flat: [string, { x: number; y: number }][];
  connections: DepthConnection[];
  reverse: boolean;
};
export type SpatialLayoutReply = {
  requestId: number;
  points?: [string, SpatialPoint][];
  failed?: boolean;
};
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SpatialLayoutRequest>) => void) | null;
  postMessage: (message: SpatialLayoutReply) => void;
};
scope.onmessage = ({ data }) => {
  try {
    scope.postMessage({
      requestId: data.requestId,
      points: [
        ...spatialBranchLayout(
          new Map(data.flat),
          data.connections,
          data.reverse,
        ),
      ],
    });
  } catch {
    scope.postMessage({ requestId: data.requestId, failed: true });
  }
};
