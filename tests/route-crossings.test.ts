import test from "node:test";
import assert from "node:assert/strict";
import {
  crossingGeometryKey,
  crossingPaths,
  createCrossingPathCache,
  type CrossingEdge,
} from "../src/domain/route-crossings.ts";

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
