import test from "node:test";
import assert from "node:assert/strict";
import type { PersonNodeType } from "../src/components/tree/person-node.tsx";
import { treeMotionOrigins } from "../src/components/tree/tree-motion-origins.ts";

function node(id: string, parents: string[] = [], spouses: string[] = []): PersonNodeType {
  return { id, type: "person", position: { x: 900, y: 900 }, data: { collapsed: false, childrenCount: 0, dimmed: false, person: {
    id, name: id, surname: "", patronymic: "", sex: "u", birth: "", birthPlace: "",
    parents, spouses, sources: [], generation: 0, column: 0,
  } } };
}

test("new relatives unfold from retained family across multiple generations and asymmetric spouse records", () => {
  const nodes = [node("anchor"), node("parent", [], ["partner"]), node("child", ["parent"]),
    node("partner", ["anchor"]), node("unrelated")];
  const old = new Map([["anchor", { x: 40, y: 80, opacity: 0.7 }]]);
  const origins = treeMotionOrigins(nodes, old);
  assert.deepEqual([...origins.keys()].sort(), ["child", "parent", "partner"]);
  for (const point of origins.values()) assert.deepEqual(point, { x: 40, y: 80, opacity: 0 });
  assert.deepEqual(old.get("anchor"), { x: 40, y: 80, opacity: 0.7 });
});

test("multiple retained relatives stay put and no hidden person bridges disconnected visible cards", () => {
  const nodes = [node("left"), node("right"), node("child", ["right"]), node("other", ["hidden"]),
    { ...node("left"), id: "left-copy" }];
  const origins = treeMotionOrigins(nodes, new Map([
    ["left", { x: 0, y: 0 }], ["right", { x: 500, y: 20 }],
  ]));
  assert.deepEqual(origins.get("child"), { x: 500, y: 20, opacity: 0 });
  assert.deepEqual(origins.get("left-copy"), { x: 0, y: 0, opacity: 0 });
  assert.equal(origins.has("other"), false);
});
