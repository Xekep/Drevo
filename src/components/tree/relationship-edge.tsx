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
import { edgeLabelPlacement } from "./edge-label-placement";
export type RelationshipEdgeType = Edge<
  {
    connection: GraphConnection;
    label?: string;
    reverseLabel?: string;
    onSelect: (edge: GraphConnection) => void;
    route?: EdgeRoute;
    path?: string;
    junction?: { x: number; y: number };
  },
  "relationship" | "smoothstep"
>;

function shallowRecordEqual(a: unknown, b: unknown) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
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
    ad?.label === bd?.label &&
    ad?.reverseLabel === bd?.reverseLabel &&
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
  const renderedPath = props.data?.path || path;
  const edge = props.data!.connection;
  const label = props.data?.label || CONNECTION_NAMES[edge.type];
  const inlineLabel = !["parent", "spouse"].includes(edge.type);
  const placement = inlineLabel
    ? edgeLabelPlacement(props.data?.route?.points, {
        x,
        y,
        source: { x: props.sourceX, y: props.sourceY },
        target: { x: props.targetX, y: props.targetY },
      })
    : { x, y, vertical: false, reversed: false };
  const visibleLabel =
    placement.reversed && inlineLabel
      ? props.data?.reverseLabel || label
      : label;
  const animatedStyle = { ...props.style } as CSSProperties & {
    "--tree-growth-delay"?: string;
    "--tree-edge-label-delay"?: string;
  };
  const visualStyle = {
    "--tree-growth-delay": animatedStyle["--tree-growth-delay"] || "0ms",
    "--tree-edge-label-delay":
      animatedStyle["--tree-edge-label-delay"] || "0ms",
  } as CSSProperties;
  const labelStyle = {
    transform: `translate(${placement.x}px,${placement.y}px) rotate(${placement.vertical ? 90 : 0}deg)`,
    "--tree-growth-delay": animatedStyle["--tree-edge-label-delay"] || "0ms",
  } as CSSProperties;
  return (
    <>
      <g className="tree-grow-edge-visual" style={visualStyle}>
        <BaseEdge
          className="tree-edge-final-path"
          path={renderedPath}
          markerEnd={props.markerEnd}
          style={animatedStyle}
          interactionWidth={24}
        />
        <path
          aria-hidden="true"
          className="react-flow__edge-path tree-edge-growth-path"
          d={renderedPath}
          fill="none"
          pathLength={1}
          style={{ ...animatedStyle, strokeDasharray: undefined }}
        />
        {props.data?.junction && (
          <circle
            className="tree-grow-edge-junction"
            cx={props.data.junction.x}
            cy={props.data.junction.y}
            r={2.4}
            fill={props.style?.stroke || "#58775a"}
            pointerEvents="none"
          />
        )}
      </g>
      {(props.selected || !["parent", "spouse"].includes(edge.type)) && (
        <EdgeLabelRenderer>
          <div className="tree-edge-label-anchor" style={labelStyle}>
            <button
              className={`flow-edge-label tree-grow-edge-label nodrag nopan ${inlineLabel ? "is-inline" : ""} ${props.selected ? "selected" : ""}`}
              onClick={() => props.data!.onSelect(edge)}
              aria-label={`Связь: ${label}`}
            >
              {props.selected && edge.type === "parent" ? "Родитель" : visibleLabel}
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}, sameRelationshipEdgeProps);
