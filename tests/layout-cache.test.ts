import test from "node:test";
import assert from "node:assert/strict";
import {
  createLayoutMemoryCache,
  layoutCacheKey,
} from "../src/components/tree/layout-cache.ts";
import { projectTree } from "../src/domain/family-neighborhood.ts";
import type { Person } from "../src/domain/types.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import {
  readLayout,
  writeLayout,
  clearLayoutStorage,
} from "../src/components/tree/layout-storage.ts";

const parent = {
  id: "parent",
  birth: "1900",
  parents: [],
  spouses: [],
} as unknown as Person;
const child = {
  id: "child",
  birth: "1930",
  parents: ["parent"],
  spouses: [],
} as unknown as Person;
const geometry: TreeGeometry = {
  mode: "generations",
  reverse: false,
  start: 1830,
  offset: 0,
  positions: [
    ["parent", { x: 0, y: 0 }],
    ["child", { x: 0, y: 196 }],
  ],
  routes: [
    [
      "edge",
      {
        sourceHandle: "bottom",
        targetHandle: "top",
        points: [
          { x: 110, y: 96 },
          { x: 110, y: 196 },
        ],
      },
    ],
  ],
  coveredRelations: ["parent:child"],
};
const key = (people: Person[], visible = new Set(people.map((p) => p.id))) =>
  layoutCacheKey({
    ...projectTree({ people }, visible),
    mode: "generations",
    reverse: false,
  });

test("layout key ignores metadata and object identity but includes dates, relations and visibility", () => {
  const original = key([parent, child]);
  assert.equal(
    key([{ ...parent, name: "Новое имя", photo: "/photo/new" }, { ...child }]),
    original,
  );
  assert.notEqual(key([parent, { ...child, birth: "1931" }]), original);
  assert.notEqual(key([parent, { ...child, parents: [] }]), original);
  assert.notEqual(key([parent, child], new Set([parent.id])), original);
  const input = {
    people: [parent, child],
    links: [],
    mode: "generations" as const,
    reverse: false,
  };
  assert.notEqual(
    layoutCacheKey({ ...input, cardVariant: "classic" }),
    layoutCacheKey({ ...input, cardVariant: "portrait" }),
  );
  assert.notEqual(
    layoutCacheKey(input),
    layoutCacheKey({ ...input, reverse: true }),
  );
  assert.notEqual(
    layoutCacheKey(input),
    layoutCacheKey({ ...input, mode: "timeline" }),
  );
  assert.notEqual(
    layoutCacheKey(input),
    layoutCacheKey({
      ...input,
      links: [{ from: parent.id, to: child.id, type: "godparent" }],
    }),
  );
});

test("LRU retains the full geometry and evicts least recently used layouts", () => {
  const cache = createLayoutMemoryCache(2);
  cache.set("all", geometry);
  cache.set("family", { ...geometry, positions: [] });
  assert.deepEqual(cache.get("all"), geometry);
  cache.set("collapsed", geometry);
  assert.equal(cache.get("family"), undefined);
  assert.deepEqual(cache.get("all")?.routes, geometry.routes);
  assert.deepEqual(
    cache.get("all")?.coveredRelations,
    geometry.coveredRelations,
  );
  assert.equal(createLayoutMemoryCache().get("all"), undefined);
});

test("cache enforces its byte budget, including keys and replacement entries", () => {
  const bytes = 2 * (JSON.stringify(geometry).length + 1);
  const cache = createLayoutMemoryCache(20, bytes);
  cache.set("a", geometry);
  cache.set("a", geometry);
  assert.ok(cache.get("a"));
  cache.set("b", geometry);
  assert.equal(cache.get("a"), undefined);
  assert.ok(cache.get("b"));
  cache.set("b", {
    ...geometry,
    positions: [...geometry.positions, ...geometry.positions],
  });
  assert.equal(cache.get("b"), undefined);
});

test("unavailable browser storage is a cache miss, never a layout failure", async () => {
  assert.equal(await readLayout("user", "key"), undefined);
  await writeLayout("user", "key", geometry);
  await clearLayoutStorage();
});
