import test from "node:test";
import assert from "node:assert/strict";
import {
  treeGeometry,
  TREE_NODE_WIDTH,
  TREE_NODE_HEIGHT,
  type LayoutPerson,
} from "../src/domain/tree-layout.ts";
import {
  routeRelationships,
  routeKey,
  segmentHitsBox,
  roundedRoute,
  type EdgeRoute,
} from "../src/domain/edge-routing.ts";
import { segmentsCross, type Point } from "../src/domain/layout-order.ts";

const person = (
  id: string,
  parents: string[] = [],
  spouses: string[] = [],
  birth = "",
): LayoutPerson => ({ id, birth, parents, spouses });
function verifyRoutes(
  positions: [string, Point][],
  routes: [string, EdgeRoute][],
) {
  for (const [key, route] of routes) {
    assert.ok(route.points.length >= 2, key);
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1],
        b = route.points[i];
      assert.ok(a.x === b.x || a.y === b.y, `diagonal: ${key}`);
      for (const [id, p] of positions)
        assert.equal(
          segmentHitsBox(a, b, {
            left: p.x,
            right: p.x + TREE_NODE_WIDTH,
            top: p.y,
            bottom: p.y + TREE_NODE_HEIGHT,
          }),
          false,
          `${key} goes through ${id}`,
        );
    }
    const rendered = roundedRoute(route.points);
    assert.ok(!rendered.path.includes("NaN"));
    const last = route.points.at(-1)!;
    assert.ok(rendered.path.endsWith(`L ${last.x} ${last.y}`));
  }
}
function crossings(routes: [string, EdgeRoute][]) {
  let result = 0;
  for (let i = 0; i < routes.length; i++)
    for (let j = 0; j < i; j++) {
      const a = routes[i][1].points,
        b = routes[j][1].points;
      for (let k = 1; k < a.length; k++)
        for (let l = 1; l < b.length; l++)
          if (segmentsCross([a[k - 1], a[k]], [b[l - 1], b[l]])) result++;
    }
  return result;
}

test("two parents and three children use a common family line without crossed arrows", () => {
  const people = [
    person("father"),
    person("mother"),
    ...["a", "b", "c"].map((id) => person(id, ["father", "mother"])),
  ];
  const before = structuredClone(people);
  for (const reverse of [false, true]) {
    const geometry = treeGeometry(people, "generations", reverse);
    assert.equal(geometry.routes!.length, 6);
    assert.equal(crossings(geometry.routes!), 0);
    verifyRoutes(geometry.positions, geometry.routes!);
    for (const [, route] of geometry.routes!) {
      assert.equal(route.sourceHandle, reverse ? "top" : "bottom");
      assert.equal(route.targetHandle, reverse ? "bottom" : "top");
    }
  }
  assert.deepEqual(people, before);
});

test("marriage joining two ancestral branches places partners toward their own parents", () => {
  const people = [
    person("a-father"),
    person("a-mother"),
    person("z-father"),
    person("z-mother"),
    person("z-child", ["a-father", "a-mother"], ["a-child"]),
    person("a-child", ["z-father", "z-mother"], ["z-child"]),
    person("grandchild", ["z-child", "a-child"]),
  ];
  const geometry = treeGeometry(people, "generations"),
    points = new Map(geometry.positions);
  assert.ok(points.get("z-child")!.x < points.get("a-child")!.x);
  assert.equal(points.get("a-father")!.y, points.get("z-father")!.y);
  assert.equal(geometry.routes!.length, 7);
  assert.equal(crossings(geometry.routes!), 0);
  verifyRoutes(geometry.positions, geometry.routes!);
});

test("co-parents align even when a marriage is unrecorded and one ancestry is unknown", () => {
  const people = [
    person("ancestor"),
    person("known", ["ancestor"]),
    person("unknown"),
    person("child", ["known", "unknown"]),
  ];
  const before = structuredClone(people),
    geometry = treeGeometry(people, "generations"),
    points = new Map(geometry.positions);
  assert.equal(points.get("known")!.y, points.get("unknown")!.y);
  assert.equal(geometry.routes!.length, 3);
  verifyRoutes(geometry.positions, geometry.routes!);
  assert.deepEqual(people, before);
});

test("remarriage and godparents keep every relationship and route around other cards", () => {
  const people = [
    person("a", [], ["b", "c"]),
    person("b", [], ["a"]),
    person("c", [], ["a"]),
    person("child-one", ["a", "b"]),
    person("child-two", ["a", "c"]),
    person("godparent"),
  ];
  const geometry = treeGeometry(people, "generations", false, [
    { type: "godparent", from: "godparent", to: "child-two" },
  ]);
  assert.equal(geometry.routes!.length, 7);
  verifyRoutes(geometry.positions, geometry.routes!);
});

test("timeline preserves actual years while routing through free corridors in both directions", () => {
  const people = [
    person("a", [], ["b"], "1900"),
    person("b", [], ["a"], "1904"),
    person("child-a", ["a", "b"], [], "1930"),
    person("child-b", ["a", "b"], [], "1935"),
    person("other", [], [], "1915"),
  ];
  for (const reverse of [false, true]) {
    const geometry = treeGeometry(people, "timeline", reverse),
      points = new Map(geometry.positions);
    assert.equal(Math.abs(points.get("a")!.y - points.get("b")!.y), 32);
    assert.equal(geometry.routes!.length, 5);
    verifyRoutes(geometry.positions, geometry.routes!);
  }
});

test("a long additional relationship detours around intervening people", () => {
  const people = [
    person("a"),
    person("b"),
    person("obstacle-1"),
    person("obstacle-2"),
    person("obstacle-3"),
  ];
  const positions: [string, Point][] = [
    ["a", { x: 0, y: 0 }],
    ["b", { x: 0, y: 600 }],
    ["obstacle-1", { x: -100, y: 160 }],
    ["obstacle-2", { x: 100, y: 310 }],
    ["obstacle-3", { x: -100, y: 460 }],
  ];
  const routes = routeRelationships(
    people,
    [{ type: "guardian", from: "a", to: "b" }],
    positions,
    TREE_NODE_WIDTH,
    TREE_NODE_HEIGHT,
  );
  assert.equal(routes.length, 1);
  assert.equal(
    routes[0][0],
    routeKey({ type: "guardian", from: "a", to: "b" }),
  );
  assert.ok(routes[0][1].points.length > 2);
  verifyRoutes(positions, routes);
});

test("routing can leave a card through the narrow twenty-pixel timeline gap", () => {
  const people = [person("a"), person("b"), person("obstacle")];
  const positions: [string, Point][] = [
    ["a", { x: 0, y: 0 }],
    ["b", { x: 0, y: 400 }],
    ["obstacle", { x: 0, y: 116 }],
  ];
  const routes = routeRelationships(
    people,
    [{ type: "guardian", from: "a", to: "b" }],
    positions,
    TREE_NODE_WIDTH,
    TREE_NODE_HEIGHT,
  );
  assert.equal(routes.length, 1);
  verifyRoutes(positions, routes);
});
