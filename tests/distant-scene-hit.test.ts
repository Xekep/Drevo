import test from "node:test";
import assert from "node:assert/strict";
import { hitDistantScene } from "../src/components/tree/distant-scene-hit.ts";
import type { PersonNodeType } from "../src/components/tree/person-node.tsx";
import type { RelationshipEdgeType } from "../src/components/tree/relationship-edge.tsx";

const node = (id: string, x: number, y: number) => ({
  id, type: "person", position: { x, y }, width: 100, height: 80,
  data: { person: { id } },
}) as PersonNodeType;
const edge = {
  id: "edge", source: "a", target: "b", type: "relationship",
  data: { route: { points: [{ x: 150, y: 40 }, { x: 250, y: 40 }] } },
} as RelationshipEdgeType;

test("distant scene hits cards and routes using the camera transform", () => {
  const nodes = [node("a", 0, 0), node("b", 300, 0)];
  const camera = { x: 40, y: 20, zoom: 0.5 };
  assert.equal(hitDistantScene(nodes, [edge], camera, { x: 65, y: 40 })?.node?.id, "a");
  assert.equal(hitDistantScene(nodes, [edge], camera, { x: 140, y: 40 })?.edge?.id, "edge");
  assert.equal(hitDistantScene(nodes, [edge], camera, { x: 140, y: 55 }), null);
});

test("distant scene gives a card priority where a route touches it", () => {
  const overlapping = {
    ...edge,
    data: { route: { points: [{ x: 0, y: 40 }, { x: 250, y: 40 }] } },
  } as RelationshipEdgeType;
  assert.equal(hitDistantScene([node("a", 0, 0)], [overlapping],
    { x: 0, y: 0, zoom: 1 }, { x: 50, y: 40 })?.node?.id, "a");
});
