import { MarkerType } from "@xyflow/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ArchiveUser } from "../../domain/access.ts";
import {
  canChangeConnection,
  connectionKey,
  type GraphConnection,
} from "../../domain/connections.ts";
import { fullName } from "../../domain/dates.ts";
import { routeKey } from "../../domain/edge-routing.ts";
import { crossingPaths } from "../../domain/route-crossings.ts";
import type { TreeGeometry, TreeMode } from "../../domain/tree-layout.ts";
import type { Family, Person } from "../../domain/types.ts";
import type { RelationshipEdgeType } from "./relationship-edge.tsx";
import { treeEdgeGrowthStyle } from "./tree-growth.ts";

const colors = {
  parent: "#58775a",
  spouse: "#b38167",
  adoptive_parent: "#638fa0",
  godparent: "#9b83ac",
  guardian: "#8d9860",
  nurse: "#a58958",
  sworn_sibling: "#748ca9",
};

const patterns = {
  parent: undefined,
  spouse: "7 4",
  adoptive_parent: "10 4",
  godparent: "5 5",
  guardian: "10 3 2 3",
  nurse: "2 3",
  sworn_sibling: "7 3 2 3",
};

type Point = { x: number; y: number };

type EdgeAdapterInput = {
  family: Family;
  user: ArchiveUser | null;
  mode: TreeMode;
  geometry: TreeGeometry | null;
  connections: GraphConnection[];
  visible: ReadonlySet<string>;
  positions: Map<string, Point>;
  occurrencePeople: Map<string, string>;
  peopleMap: Map<string, Person>;
  highlighted: string[];
  selectedEdge?: string;
  canEdit: boolean;
  busy: boolean;
  extraVisible: boolean;
  preview: { from: string; to: string } | null;
  onEdge: (edge: GraphConnection) => void;
  onChoices: (edges: GraphConnection[]) => void;
  growthLevels: ReadonlyMap<string, number>;
};

function isHighlighted(
  highlighted: string[],
  edge: Pick<GraphConnection, "from" | "to">,
) {
  return highlighted.some(
    (id, index) =>
      index > 0 &&
      ((id === edge.to && highlighted[index - 1] === edge.from) ||
        (id === edge.from && highlighted[index - 1] === edge.to)),
  );
}

function keyboardSelect(select: () => void) {
  return (event: ReactKeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  };
}

export function buildTreeEdges({
  family,
  user,
  mode,
  geometry,
  connections,
  visible,
  positions,
  occurrencePeople,
  peopleMap,
  highlighted,
  selectedEdge,
  canEdit,
  busy,
  extraVisible,
  preview,
  onEdge,
  onChoices,
  growthLevels,
}: EdgeAdapterInput): RelationshipEdgeType[] {
  const routes = new Map(geometry?.routes || []);
  const edges: RelationshipEdgeType[] = connections
    .filter(
      (edge) =>
        visible.has(edge.from) &&
        visible.has(edge.to) &&
        positions.has(edge.from) &&
        positions.has(edge.to) &&
        (!geometry?.branches ||
          (geometry.coveredRelations
            ? !geometry.coveredRelations.includes(routeKey(edge))
            : !["parent", "spouse"].includes(edge.type))) &&
        (extraVisible || ["parent", "spouse"].includes(edge.type)),
    )
    .map((edge) => {
      const from = positions.get(edge.from),
        to = positions.get(edge.to),
        side = ["spouse", "sworn_sibling"].includes(edge.type),
        route = routes.get(routeKey(edge)),
        active = isHighlighted(highlighted, edge),
        select = () => onEdge(edge);
      return {
        id: edge.key,
        source: edge.from,
        target: edge.to,
        type: "relationship",
        sourceHandle:
          route?.sourceHandle ??
          (side
            ? from && to && from.x > to.x
              ? "left"
              : "right"
            : from && to && from.y > to.y
              ? "top"
              : "bottom"),
        targetHandle:
          route?.targetHandle ??
          (side
            ? from && to && from.x > to.x
              ? "right"
              : "left"
            : from && to && from.y > to.y
              ? "bottom"
              : "top"),
        selected: selectedEdge === edge.key,
        className: `tree-grow-edge relationship-${edge.type}`,
        data: { connection: edge, onSelect: onEdge, route },
        style: {
          stroke: colors[edge.type],
          strokeWidth: active || selectedEdge === edge.key ? 3 : 1.6,
          strokeDasharray: patterns[edge.type],
          ...treeEdgeGrowthStyle(
            Math.max(
              growthLevels.get(edge.from) || 0,
              growthLevels.get(edge.to) || 0,
            ),
          ),
        },
        markerEnd: side
          ? undefined
          : {
              type: MarkerType.ArrowClosed,
              color: colors[edge.type],
              width: 16,
              height: 16,
            },
        reconnectable:
          canEdit &&
          !busy &&
          canChangeConnection(family, user, edge, peopleMap),
        focusable: true,
        domAttributes: { onKeyDown: keyboardSelect(select) },
        ariaLabel: `${fullName(peopleMap.get(edge.from)!)} — ${fullName(peopleMap.get(edge.to)!)}`,
      };
    });

  const actual = new Map(connections.map((edge) => [edge.key, edge]));
  const familyEdges: RelationshipEdgeType[] = (
    geometry?.mode === mode ? geometry.branches || [] : []
  )
    .filter(
      (branch) =>
        visible.has(occurrencePeople.get(branch.source)!) &&
        visible.has(occurrencePeople.get(branch.target)!) &&
        positions.has(branch.source) &&
        positions.has(branch.target),
    )
    .flatMap((branch) => {
      const choices = branch.relations
        .filter(
          (relation) => visible.has(relation.from) && visible.has(relation.to),
        )
        .map((relation) => actual.get(connectionKey(relation)))
        .filter((edge): edge is GraphConnection => !!edge);
      if (!choices.length) return [];
      const edge = choices[0],
        selected = choices.some((choice) => choice.key === selectedEdge),
        active = choices.some((choice) => isHighlighted(highlighted, choice)),
        select = () =>
          choices.length === 1 ? onEdge(edge) : onChoices(choices);
      return [
        {
          id: branch.id,
          source: branch.source,
          target: branch.target,
          type: "relationship" as const,
          sourceHandle: branch.route.sourceHandle,
          targetHandle: branch.route.targetHandle,
          selected,
          className: `tree-grow-edge relationship-${edge.type}`,
          data: {
            connection: edge,
            onSelect: select,
            route: branch.route,
            junction:
              branch.id.startsWith("child:") && branch.relations.length > 1
                ? branch.route.points[0]
                : undefined,
          },
          style: {
            stroke: edge.type === "spouse" ? colors.spouse : colors.parent,
            strokeWidth: selected || active ? 2.8 : 1.6,
            ...treeEdgeGrowthStyle(
              Math.max(
                growthLevels.get(occurrencePeople.get(branch.source)!) || 0,
                growthLevels.get(occurrencePeople.get(branch.target)!) || 0,
              ),
            ),
          },
          reconnectable: false,
          focusable: true,
          ariaLabel: choices
            .map(
              (choice) =>
                `${fullName(peopleMap.get(choice.from)!)} — ${fullName(peopleMap.get(choice.to)!)}`,
            )
            .join("; "),
          domAttributes: { onKeyDown: keyboardSelect(select) },
        },
      ];
    });

  const combined = [...familyEdges, ...edges];
  const groups = new Map(
    (geometry?.branches || []).map((branch) => [branch.id, branch.union]),
  );
  const paths = crossingPaths(
    combined.map((edge) => ({
      id: edge.id,
      group: groups.get(edge.id) || edge.id,
      route: edge.data?.route,
    })),
  );
  const withCrossings = combined.map((edge) =>
    paths.has(edge.id)
      ? { ...edge, data: { ...edge.data!, path: paths.get(edge.id) } }
      : edge,
  );

  if (!preview?.from || !preview.to || preview.from === preview.to)
    return withCrossings;
  return [
    ...withCrossings,
    {
      id: "draft-preview",
      source: preview.from,
      target: preview.to,
      sourceHandle: "bottom",
      targetHandle: "top",
      type: "smoothstep",
      label: "Предпросмотр",
      style: {
        stroke: "#527d67",
        strokeWidth: 3,
        strokeDasharray: "5 5",
      },
      reconnectable: false,
    },
  ];
}
