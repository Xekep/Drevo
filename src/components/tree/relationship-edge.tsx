import { memo, type CSSProperties } from "react";
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

function shallowRecordEqual(a: unknown, b: unknown) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object")
    return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>,
    keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

function sameRelationshipEdgeProps(
  a: EdgeProps<RelationshipEdgeType>,
  b: EdgeProps<RelationshipEdgeType>,
) {
  const ad = a.data,
    bd = b.data;
  return (
    a.id === b.id &&
    a.selected === b.selected &&
    a.sourceX === b.sourceX &&
    a.sourceY === b.sourceY &&
    a.targetX === b.targetX &&
    a.targetY === b.targetY &&
    a.sourcePosition === b.sourcePosition &&
    a.targetPosition === b.targetPosition &&
    shallowRecordEqual(a.style, b.style) &&
    shallowRecordEqual(a.markerEnd, b.markerEnd) &&
    ad?.connection === bd?.connection &&
    ad?.onSelect === bd?.onSelect &&
    ad?.route === bd?.route &&
    ad?.path === bd?.path &&
    (ad?.junction === bd?.junction ||
      (ad?.junction?.x === bd?.junction?.x &&
        ad?.junction?.y === bd?.junction?.y))
  );
}

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
  const animatedStyle = {
    ...props.style,
    "--tree-marker-end": props.markerEnd || "none",
  } as CSSProperties;
  return (
    <>
      <BaseEdge
        path={props.data?.path || path}
        pathLength={1}
        markerEnd={props.markerEnd}
        style={animatedStyle}
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
}, sameRelationshipEdgeProps);
