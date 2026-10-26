import test from "node:test";
import assert from "node:assert/strict";
import {
  crossingGeometryKey,
  crossingPaths,
  createCrossingPathCache,
  type CrossingEdge,
} from "../src/domain/route-crossings.ts";
import { gpuRoute } from "../src/components/tree/gpu-route.ts";
import { crossingZoomBucket } from "../src/domain/route-crossings.ts";
import { visitRouteCrossings } from "../src/domain/route-crossing-index.ts";

function renderedSegments(edge: CrossingEdge, paths: ReadonlyMap<string, string>) {
  const path = paths.get(edge.id);
  return path ? gpuRoute(path) : edge.route!.points.slice(1).map((b, i) => ({
    ax: edge.route!.points[i].x, ay: edge.route!.points[i].y, bx: b.x, by: b.y,
  }));
}

function assertSeparated(edges: CrossingEdge[], paths: ReadonlyMap<string, string>) {
  const h = renderedSegments(edges[0], paths);
  for (const edge of edges.slice(1)) for (const v of renderedSegments(edge, paths)) {
    for (const a of h) {
      // Samples of the actual rendered curve, including inclusive T contacts.
      if (Math.min(a.ax, a.bx) > v.ax || Math.max(a.ax, a.bx) < v.ax) continue;
      if (a.ax === a.bx) continue;
      const y = a.ay + (a.by - a.ay) * (v.ax - a.ax) / (a.bx - a.ax);
      assert.ok(y < Math.min(v.ay, v.by) || y > Math.max(v.ay, v.by),
        `${edge.id} still touches the displayed horizontal path at ${v.ax},${y}`);
    }
  }
}

const horizontal = (x = 50): CrossingEdge[] => [
  {
    id: "horizontal",
    group: "family-a",
    route: {
      sourceHandle: "right",
      targetHandle: "left",
      points: [
        { x: 0, y: 50 },
        { x: 100, y: 50 },
      ],
    },
  },
  {
    id: "vertical",
    group: "family-b",
    route: {
      sourceHandle: "bottom",
      targetHandle: "top",
      points: [
        { x, y: 0 },
        { x, y: 100 },
      ],
    },
  },
];

test("crossing geometry key depends only on ids, groups and route geometry", () => {
  const first = horizontal(),
    clone = structuredClone(first);
  assert.equal(crossingGeometryKey(first), crossingGeometryKey(clone));
  clone[1].route!.points[0].x = 60;
  clone[1].route!.points[1].x = 60;
  assert.notEqual(crossingGeometryKey(first), crossingGeometryKey(clone));
});

test("crossing paths reuse the previous calculation for identical geometry", () => {
  const first = crossingPaths(horizontal());
  assert.ok(first.get("horizontal"), "горизонтальная линия получает разрыв");

  const sameGeometry = crossingPaths(structuredClone(horizontal()));
  assert.equal(
    sameGeometry,
    first,
    "новые edge-объекты с прежними маршрутами используют тот же результат",
  );

  const changedGeometry = crossingPaths(horizontal(65));
  assert.notEqual(changedGeometry, first, "изменение маршрута инвалидирует кэш");
  assert.notEqual(
    changedGeometry.get("horizontal"),
    first.get("horizontal"),
    "разрыв пересчитывается в новой координате",
  );
});

test("branches from one group do not receive artificial crossing gaps", () => {
  const edges = horizontal();
  edges[1].group = edges[0].group;
  assert.equal(crossingPaths(edges).size, 0);
});

test("a canvas crossing cache retains full geometry across a small projection and isolated canvases", () => {
  const cache = createCrossingPathCache();
  const full = horizontal();
  const original = structuredClone(full);
  const paths = cache(full);
  const small = cache(full.slice(0, 1));
  assert.equal(small.size, 0);
  assert.equal(cache(structuredClone(full)), paths);
  assert.deepEqual(full, original);
  const isolated = createCrossingPathCache()(full);
  assert.notEqual(isolated, paths, "another archive/read scope owns a new cache");
  assert.deepEqual([...isolated], [...paths]);
});

test("four-entry crossing cache promotes hits and evicts the least recently used fifth geometry", () => {
  const cache = createCrossingPathCache();
  const first = cache(horizontal(40));
  const second = cache(horizontal(45));
  cache(horizontal(50));
  cache(horizontal(55));
  assert.equal(cache(horizontal(40)), first);
  cache(horizontal(60));
  assert.equal(cache(horizontal(40)), first, "a hit promotes the retained entry");
  assert.notEqual(cache(horizontal(45)), second, "the fifth key evicts the old second entry");
});

test("crossing cache uses exact geometry values, groups, handles and input order rather than object identity", () => {
  const cache = createCrossingPathCache();
  const original = horizontal();
  const first = cache(original);
  const changed = [
    (edges: CrossingEdge[]) => { edges[1].route!.points[0].x = 65; },
    (edges: CrossingEdge[]) => { edges[1].group = edges[0].group; },
    (edges: CrossingEdge[]) => { edges[0].route!.sourceHandle = "top"; },
    (edges: CrossingEdge[]) => { edges[0].route!.targetHandle = "bottom"; },
    (edges: CrossingEdge[]) => { edges.reverse(); },
  ];
  const cold = createCrossingPathCache(0);
  for (const change of changed) {
    // Mutate the same caller-owned object after caching its previous geometry.
    const edges = structuredClone(original);
    const before = cache(edges);
    assert.equal(before, first);
    change(edges);
    const next = cache(edges);
    assert.notEqual(next, first);
    assert.deepEqual([...next], [...cold(edges)]);
    assert.equal(cache(original), first, "mutation cannot modify the previously cached result");
  }
});

test("crossing cache enforces a combined string budget and bypasses oversized results without flushing useful entries", () => {
  const cold = createCrossingPathCache(0);
  const size = (edges: CrossingEdge[]) => {
    let bytes = 2 * crossingGeometryKey(edges).length;
    for (const [id, path] of cold(edges)) bytes += 2 * (id.length + path.length);
    return bytes;
  };
  const a = horizontal(40), b = horizontal(45);
  const cache = createCrossingPathCache(4, size(a) + size(b) - 1);
  const first = cache(a), second = cache(b);
  assert.equal(cache(b), second);
  assert.notEqual(cache(a), first, "the shared byte budget evicts even below four entries");
  const bounded = createCrossingPathCache(4, size(a));
  const retained = bounded(a);
  const oversized = horizontal(65);
  oversized[0].id = "oversized".repeat(1000);
  const uncached = bounded(oversized);
  assert.deepEqual([...uncached], [...cold(oversized)]);
  assert.notEqual(bounded(oversized), uncached);
  assert.equal(bounded(a), retained, "an oversized key does not evict a useful result");
});

test("nearby crossings share an arch and every intersecting line is separated", () => {
  const edges = horizontal();
  const second = structuredClone(horizontal(58)[1]);
  second.id = "vertical-2";
  edges.push(second);
  const original = structuredClone(edges), paths = crossingPaths(edges);
  assert.match(paths.get("horizontal")!, /Q/);
  assertSeparated(edges, paths);
  assert.deepEqual(edges, original, "bridges must not change logical routes");
  for (const edge of edges) edge.route!.points.reverse();
  assertSeparated(edges, crossingPaths(edges));
});

test("foreign T and near-end contacts are separated, real shared endpoints remain joined", () => {
  for (const x of [0, 3, 8, 50, 100]) {
    const edges = horizontal(x);
    edges[1].route!.points[1].y = 50;
    assertSeparated(edges, crossingPaths(edges));
    assert.ok(crossingPaths(edges).has("horizontal"));
  }
  const shared = horizontal(0);
  shared[0].source = "junction";
  shared[1].target = "junction";
  shared[1].route!.points[1].y = 50;
  assert.equal(crossingPaths(shared).size, 0, "the same actual node is a junction");
  shared[1].target = "different-node";
  assert.ok(crossingPaths(shared).size, "coincident coordinates alone are not a family junction");
});

test("arch never detours into a card; overview size is bucketed and bounded", () => {
  const edges = horizontal();
  const blocked = crossingPaths(edges, { obstacles: [{ left: 48, right: 52, top: 45, bottom: 49 }] });
  assert.doesNotMatch(blocked.get("horizontal")!, /Q/);
  assertSeparated(edges, blocked);
  const cache = createCrossingPathCache(), normal = cache(edges, { zoom: 1 });
  assert.equal(cache(edges, { zoom: 1.01 }), normal);
  const overview = cache(edges, { zoom: 0.2 });
  assert.notEqual(overview, normal);
  assertSeparated(edges, overview);
  assertSeparated(edges, cache(edges, { zoom: 0.00001 }));
  assert.equal(crossingZoomBucket(NaN), 1);
  assert.equal(crossingZoomBucket(0), 0.05);
  assert.equal(crossingZoomBucket(100), 2);
});

test("active oversized paths are weakly reused without an unbounded strong cache", () => {
  const edges = horizontal();
  for (let i = 0; i < 60; i++) {
    const h = structuredClone(horizontal()[0]);
    h.id = `h-${i}`;
    h.route!.points = [{ x: 0, y: i + 1 }, { x: 100, y: i + 1 }];
    edges.push(h);
  }
  const keyBytes = crossingGeometryKey(edges).length * 2;
  const cache = createCrossingPathCache(1, keyBytes + 32);
  const paths = cache(edges);
  let fullBytes = keyBytes;
  for (const [id, path] of paths) fullBytes += 2 * (id.length + path.length);
  assert.ok(fullBytes > keyBytes + 32);
  assert.equal(cache(structuredClone(edges)), paths, "current scene keeps its weak entry alive");
  cache(horizontal(65));
  assert.notEqual(cache(edges), paths, "entry count still bounds weak entries");
});

test("a bridge cannot create a new contact with a nearby route that missed the original baseline", () => {
  for (const points of [
    [{ x: 44, y: 47.5 }, { x: 49.5, y: 47.5 }],
    [{ x: 48, y: 40 }, { x: 48, y: 49 }],
  ]) {
    const edges = horizontal();
    edges.push({ id: "nearby", group: "third-family", route: {
      sourceHandle: "right", targetHandle: "left", points,
    } });
    assert.doesNotMatch(crossingPaths(edges).get("horizontal")!, /Q/,
      "use a transparent gap where an arch would touch a third route");
  }
});

test("sweep matches brute force including reversed segments, endpoints and disjoint spans", () => {
  const edges: CrossingEdge[] = [];
  for (let i = 0; i < 80; i++) {
    const edge = structuredClone(horizontal()[i % 2]);
    edge.id = `edge-${i}`;
    edge.group = `group-${i % 11}`;
    const x = (i * 31) % 97, y = (i * 23) % 101;
    edge.route!.points = i % 2 ? [{ x, y }, { x, y: y + 10 }] : [{ x, y }, { x: x + 20, y }];
    if (i % 3 === 0) edge.route!.points.reverse();
    edges.push(edge);
  }
  const expected: string[] = [], actual: string[] = [];
  for (const h of edges.filter((_, i) => !(i % 2))) for (const v of edges.filter((_, i) => i % 2)) {
    const [a, b] = h.route!.points, [c, d] = v.route!.points;
    if (h.group !== v.group && c.x >= Math.min(a.x, b.x) && c.x <= Math.max(a.x, b.x) &&
      a.y >= Math.min(c.y, d.y) && a.y <= Math.max(c.y, d.y)) expected.push(`${h.id}:${v.id}`);
  }
  visitRouteCrossings(edges, (h, v) => actual.push(`${h.edge.id}:${v.edge.id}`));
  assert.deepEqual(actual.sort(), expected.sort());
});
