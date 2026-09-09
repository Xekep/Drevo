import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { CONNECTION_NAMES, type GraphConnection } from "../../domain";
import { roundedRoute, type EdgeRoute } from "../../domain/edge-routing";
export type RelationshipEdgeType = Edge<
  {
    connection: GraphConnection;
    onSelect: (edge: GraphConnection) => void;
    route?: EdgeRoute;
    path?: string;
    junction?: { x: number; y: number };
  },
  "relationship" | "smoothstep"
>;
export const RelationshipEdge = memo(function RelationshipEdge(
  props: EdgeProps<RelationshipEdgeType>,
) {
  const fallback = getBezierPath({
    ...props,
    curvature: 0.35,
  });
  const { path, x, y } = props.data?.route
    ? roundedRoute(props.data.route.points)
    : { path: fallback[0], x: fallback[1], y: fallback[2] };
  const edge = props.data!.connection;
  return (
    <>
      <BaseEdge
        path={props.data?.path || path}
        markerEnd={props.markerEnd}
        style={props.style}
        interactionWidth={24}
      />
      {props.data?.junction && (
        <circle
          cx={props.data.junction.x}
          cy={props.data.junction.y}
          r={2.4}
          fill={props.style?.stroke || "#58775a"}
          pointerEvents="none"
        />
      )}
      {(props.selected || !["parent", "spouse"].includes(edge.type)) && (
        <EdgeLabelRenderer>
          <button
            className={`flow-edge-label nodrag nopan ${props.selected ? "selected" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translate(${x}px,${y}px)`,
            }}
            onClick={() => props.data!.onSelect(edge)}
            aria-label={`Связь: ${CONNECTION_NAMES[edge.type]}`}
          >
            {props.selected || edge.type !== "parent"
              ? CONNECTION_NAMES[edge.type]
              : "Родитель"}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
