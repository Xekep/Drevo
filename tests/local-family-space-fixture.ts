import { person } from "./layout-fixtures.ts";
import { familyUnions } from "../src/domain/union-layout.ts";
import { localUnionRoutes } from "../src/domain/union-groups.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";

export const spaceSize = { width: 220, height: 264 };

/** A valid saved scene with tight neighbors and a gap after each local chain.
 * Coordinates are deliberate: cold ELK is free to choose another ordering.
 */
export function crowdedFamily(count = 205, chain = 2, reverse = false) {
  const people = [person("anchor")];
  const positions: TreeGeometry["positions"] = [["anchor", { x: 0, y: 0 }]];
  for (let i = 1; i <= chain; i++) {
    people.push(person(`left-${i}`), person(`right-${i}`));
    positions.push(
      [`left-${i}`, { x: -308 * i, y: 0 }],
      [`right-${i}`, { x: 308 * i + (i > 1 ? 252 : 0), y: 0 }],
    );
  }
  people.push(person("neighbor-partner", [], ["right-1"]));
  people.find((p) => p.id === "right-1")!.spouses = ["neighbor-partner"];
  positions.push(["neighbor-partner", { x: 560, y: 0 }]);
  const couple = familyUnions(people).find((f) => f.married)!;
  const pair = localUnionRoutes(
    {
      id: couple.id,
      members: ["right-1", "neighbor-partner"],
      families: [couple],
    },
    spaceSize,
  ).families[0].pair!;
  while (people.length < count) {
    const id = `far-${people.length}`;
    people.push(person(id));
    positions.push([id, { x: 20000 + people.length * 308, y: 0 }]);
  }
  const geometry: TreeGeometry = {
    nodeSize: spaceSize,
    mode: "generations",
    reverse,
    start: 1830,
    offset: 0,
    positions,
    occurrences: people.map((p) => ({
      id: p.id,
      personId: p.id,
      block: couple.members.includes(p.id)
        ? couple.id
        : `person:${JSON.stringify(p.id)}`,
    })),
    blocks: [
      {
        id: couple.id,
        members: couple.members,
        x: 308,
        y: 0,
        width: 472,
        height: 264,
      },
    ],
    siblingGroups: [],
    routes: [],
    branches: [
      {
        id: `pair:${couple.id}`,
        union: couple.id,
        source: couple.members[0],
        target: couple.members[1],
        relations: [
          { from: couple.members[0], to: couple.members[1], type: "spouse" },
        ],
        route: {
          ...pair,
          points: pair.points.map((p) => ({ x: p.x + 308, y: p.y })),
        },
      },
    ],
    generationBands: [
      {
        level: 0,
        targetY: 0,
        minY: -30,
        maxY: 30,
        members: people.map((p) => p.id),
      },
    ],
  };
  const input = { people, links: [] };
  const next = {
    ...input,
    people: [
      ...people.map((p) =>
        p.id === "anchor" ? { ...p, spouses: ["partner"] } : p,
      ),
      person("partner", [], ["anchor"]),
    ],
  };
  return { input, next, geometry };
}
