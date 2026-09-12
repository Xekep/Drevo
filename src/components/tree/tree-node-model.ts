import type { Node } from "@xyflow/react";
import type { CSSProperties } from "react";
import {
  matchesPerson,
  TREE_NODE_HEIGHT,
  TREE_NODE_WIDTH,
  type Family,
  type TreeGeometry,
  type TreeMode,
} from "../../domain/index.ts";
import type { PersonNodeData } from "./person-node-data.ts";

type TreePersonNode = Node<PersonNodeData, "person">;
type TreeHouseholdNode = Node<
  { label?: string; reverse?: boolean },
  "household"
>;

type TreeNodeModelInput = {
  family: Family;
  geometry: TreeGeometry | null;
  mode: TreeMode;
  visible: ReadonlySet<string>;
  selected: readonly string[];
  collapsed: ReadonlySet<string>;
  root: string | null;
  hidden: ReadonlyMap<string, number>;
  expanded: ReadonlySet<string>;
  query: string;
  growthLevels: ReadonlyMap<string, number>;
};

type GrowthStyle = CSSProperties & { "--tree-growth-delay": string };
const growthStyle = (level: number): GrowthStyle => ({
  "--tree-growth-delay": `${Math.min(14, Math.max(0, level)) * 110}ms`,
});

export function buildTreeNodeModel({
  family,
  geometry,
  mode,
  visible,
  selected,
  collapsed,
  root,
  hidden,
  expanded,
  query,
  growthLevels,
}: TreeNodeModelInput) {
  const childrenCount = new Map<string, number>();
  for (const person of family.people)
    for (const parent of person.parents)
      childrenCount.set(parent, (childrenCount.get(parent) || 0) + 1);

  const positions = new Map(
    geometry?.mode === mode ? geometry.positions : [],
  );
  const occurrences =
    geometry?.mode === mode
      ? geometry.occurrences ||
        family.people.map((person) => ({
          id: person.id,
          personId: person.id,
          block: "",
        }))
      : [];
  const occurrencePeople = new Map(
    occurrences.map((occurrence) => [occurrence.id, occurrence.personId]),
  );
  const personOccurrences = new Map<string, string[]>();
  for (const occurrence of occurrences) {
    const list = personOccurrences.get(occurrence.personId) || [];
    list.push(occurrence.id);
    personOccurrences.set(occurrence.personId, list);
  }

  const households =
    geometry?.mode === mode
      ? (geometry.blocks || []).filter((block) =>
          block.members.every((id) => visible.has(occurrencePeople.get(id)!)),
        )
      : [];
  const householdMembers = new Set(
    households.flatMap((group) => group.members),
  );
  const householdNodes: TreeHouseholdNode[] = households.map((group) => ({
    id: group.id,
    type: "household",
    position: { x: group.x - 8, y: group.y - 8 },
    width: group.width + 16,
    height: group.height + 16,
    data: {},
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    zIndex: -1,
    className: "tree-grow-surface",
    style: {
      pointerEvents: "none",
      ...growthStyle(
        Math.max(
          0,
          ...group.members.map(
            (id) => growthLevels.get(occurrencePeople.get(id)!) || 0,
          ),
        ),
      ),
    },
    domAttributes: { "aria-hidden": true },
  }));
  const siblingNodes: TreeHouseholdNode[] =
    geometry?.mode === mode
      ? (geometry.siblingGroups || [])
          .filter((group) =>
            group.members.every((id) =>
              visible.has(occurrencePeople.get(id)!),
            ),
          )
          .map((group) => ({
            id: group.id,
            type: "household",
            position: { x: group.x, y: group.y },
            width: group.width,
            height: group.height,
            data: {
              label: `Дети · ${group.members.length}`,
              reverse: geometry.reverse,
            },
            draggable: false,
            selectable: false,
            connectable: false,
            focusable: false,
            zIndex: -1,
            className: "tree-grow-surface",
            style: {
              pointerEvents: "none",
              ...growthStyle(
                Math.max(
                  0,
                  ...group.members.map(
                    (id) =>
                      growthLevels.get(occurrencePeople.get(id)!) || 0,
                  ),
                ),
              ),
            },
            domAttributes: { "aria-hidden": true },
          }))
      : [];

  const peopleMap = new Map(family.people.map((person) => [person.id, person]));
  const nodes: TreePersonNode[] = occurrences
    .filter(
      (occurrence) =>
        visible.has(occurrence.personId) &&
        positions.has(occurrence.id) &&
        peopleMap.has(occurrence.personId),
    )
    .map((occurrence) => {
      const person = peopleMap.get(occurrence.personId)!;
      return {
        id: occurrence.id,
        type: "person",
        position: positions.get(occurrence.id)!,
        width: TREE_NODE_WIDTH,
        height: TREE_NODE_HEIGHT,
        selected: selected.includes(person.id),
        className: "tree-grow-node",
        style: growthStyle(growthLevels.get(person.id) || 0),
        data: {
          person,
          household: householdMembers.has(occurrence.id),
          occurrences: personOccurrences.get(person.id)?.length || 1,
          collapsed: collapsed.has(person.id),
          familyFocus: !!root,
          anchor: person.id === root,
          hiddenRelatives: hidden.get(person.id) || 0,
          expanded: expanded.has(person.id),
          childrenCount: childrenCount.get(person.id) || 0,
          dimmed: !matchesPerson(person, query),
        },
        draggable: false,
      };
    });

  return {
    childrenCount,
    positions,
    occurrences,
    occurrencePeople,
    personOccurrences,
    peopleMap,
    maxGrowthLevel: Math.max(
      0,
      ...nodes.map((node) => growthLevels.get(node.data.person.id) || 0),
    ),
    nodes,
    displayNodes: [...householdNodes, ...siblingNodes, ...nodes] as Array<
      TreePersonNode | TreeHouseholdNode
    >,
  };
}
