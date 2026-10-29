import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { randomFamily } from "./layout-fixtures.ts";
import { crowdedFamily } from "./local-family-space-fixture.ts";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const bundle = readdirSync(join(dist, "assets")).find(
  (p) => p.startsWith("layout.worker-") && p.endsWith(".js"),
);

for (const familyCount of [60, 160])
test(`production worker retains ${1 + familyCount * 6} people and every relation in both directions`, { timeout: 40000 }, async () => {
  const data = [{ id: "founder", birth: "1900", parents: [], spouses: [] }];
  for (let index = 0; index < familyCount; index++) {
    const child = `child-${index}`, spouse = `spouse-${index}`;
    data.push(
      { id: child, birth: "1930", parents: ["founder"], spouses: [spouse] },
      { id: spouse, birth: "1930", parents: [], spouses: [child] },
    );
    for (let offset = 0; offset < 4; offset++)
      data.push({ id: `grandchild-${index}-${offset}`, birth: "1960", parents: [child, spouse], spouses: [] });
  }
  assert.equal(data.length, 1 + familyCount * 6);
  const original = structuredClone(data), worker = productionWorker();
  try {
    for (const reverse of [false, true]) {
      const geometry = await calculate(worker, "generations", reverse, data, "portrait");
      assert.equal(geometry.error, undefined);
      assert.equal(geometry.reverse, reverse);
      assert.equal(geometry.positions.length, data.length);
      assert.deepEqual(new Set(geometry.occurrences.map((entry) => entry.personId)), new Set(data.map((entry) => entry.id)));
      assert.equal(geometry.branches.filter((branch) => branch.id.startsWith("child:")).length, familyCount * 5);
      const relations = new Set(geometry.branches.flatMap((branch) => branch.relations.map(({ type, from, to }) =>
        JSON.stringify(type === "spouse" ? [type, ...[from, to].sort()] : [type, from, to]))));
      const expected = new Set(data.flatMap((person) => [
        ...person.parents.map((from) => JSON.stringify(["parent", from, person.id])),
        ...person.spouses.map((to) => JSON.stringify(["spouse", ...[person.id, to].sort()])),
      ]));
      assert.deepEqual(relations, expected);
      assert.deepEqual(geometry.generationBands.map((band) => band.level), [0, 1, 2]);
      const bands = new Map(geometry.generationBands.flatMap((band) => band.members.map((id) => [id, band])));
      for (const [id, point] of geometry.positions) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
        assert.ok(point.y >= bands.get(id).minY && point.y <= bands.get(id).maxY);
      }
      for (const branch of geometry.branches)
        for (let index = 1; index < branch.route.points.length; index++) {
          const a = branch.route.points[index - 1], b = branch.route.points[index];
          assert.ok(a.x === b.x || a.y === b.y);
        }
    }
    assert.deepEqual(data, original);
  } finally {
    await worker.terminate();
  }
});
assert.ok(bundle, "Сначала выполните npm run build");
test("production spatial worker branches a real family in depth and fails closed on a malformed request", { timeout: 10000 }, async () => {
  const spatialBundle = readdirSync(join(dist, "assets")).find(p => p.startsWith("spatial-layout-worker-") && p.endsWith(".js"));
  assert.ok(spatialBundle, "Build must include the separate 3D geometry Worker");
  const worker = new Worker(new URL("./helpers/worker-runtime.mjs", import.meta.url), {
    workerData: { url: pathToFileURL(join(dist, "assets", spatialBundle)).href, dist },
  });
  const request = data => new Promise((resolve, reject) => {
    worker.once("error", reject); worker.once("message", value => { worker.off("error", reject); resolve(value); });
    worker.postMessage(data);
  });
  try {
    const result = await request({ requestId: 77, reverse: false,
      flat: [["a", { x: -140, y: 0 }], ["b", { x: 140, y: 0 }], ["c", { x: -200, y: 400 }], ["d", { x: 200, y: 400 }]],
      connections: [{ from: "a", to: "b", type: "partner" }, ...["c", "d"].flatMap(to => ["a", "b"].map(from => ({ from, to, type: "parent" })))] });
    assert.equal(result.requestId, 77); assert.equal(result.failed, undefined);
    const points = new Map(result.points);
    assert.equal(points.size, 4);
    assert.ok(points.get("c").z * points.get("d").z < 0);
    assert.ok([...points.values()].every(p => Object.values(p).every(Number.isFinite)));
    assert.deepEqual(await request({ requestId: 78, flat: null }), { requestId: 78, failed: true });
  } finally { await worker.terminate(); }
});
const people = [
  { id: "a", birth: "1900", parents: [], spouses: ["b", "c"] },
  { id: "b", birth: "", parents: [], spouses: ["a"] },
  { id: "c", birth: "", parents: [], spouses: ["a"] },
  { id: "ab", birth: "1930", parents: ["a", "b"], spouses: [] },
  { id: "ac", birth: "1935", parents: ["a", "c"], spouses: [] },
];
function calculate(
  worker,
  mode,
  reverse = false,
  data = people,
  cardVariant = "classic",
  parallelCandidates = false,
) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    const onMessage = (message) => {
      worker.off("error", onError);
      resolve(message);
    };
    worker.once("error", onError);
    worker.once("message", onMessage);
    worker.postMessage({ people: data, links: [], mode, reverse, cardVariant, parallelCandidates });
  });
}
function productionWorker() {
  return new Worker(new URL("./helpers/worker-runtime.mjs", import.meta.url), {
    workerData: {
      url: pathToFileURL(join(dist, "assets", bundle)).href,
      dist,
    },
  });
}
test("production worker opens a crowded partner slot without moving distant cards or generations", { timeout: 10000 }, async () => {
  const worker = productionWorker();
  try {
    for (const reverse of [false, true]) {
      const { input, next, geometry } = crowdedFamily(205, 2, reverse);
      const result = await new Promise((resolve, reject) => {
        const onError = error => { worker.off("message", onMessage); reject(error); };
        const onMessage = message => { worker.off("error", onError); resolve(message); };
        worker.once("message", onMessage); worker.once("error", onError);
        worker.postMessage({ requestId: 904, ...next, mode: "generations", reverse,
          previousInput: input, previousGeometry: geometry });
      });
      assert.equal(result.error, undefined); assert.equal(result.updateKind, "local");
      const points = new Map(result.geometry.positions);
      assert.deepEqual(geometry.positions.filter(([id, p]) => p.x !== points.get(id).x).map(([id]) => id), ["left-1", "left-2"]);
      for (const [id, p] of geometry.positions) assert.equal(points.get(id).y, p.y);
      assert.deepEqual(result.geometry.branches[0], geometry.branches[0]);
      assert.equal(result.geometry.occurrences.length, next.people.length);
    }
  } finally { await worker.terminate(); }
});
test("production worker retains a large edited scene, adds a safe leaf and rebuilds structural edits", { timeout: 40_000 }, async () => {
  const original = [
    { id: "a", birth: "1900", parents: [], spouses: ["b"] },
    { id: "b", birth: "1900", parents: [], spouses: ["a"] },
    { id: "c", birth: "1930", parents: ["a", "b"], spouses: [] },
    ...Array.from({ length: 500 }, (_, i) => ({ id: `isolated-${i}`, birth: "", parents: [], spouses: [] })),
  ];
  const worker = productionWorker();
  const send = body => new Promise((resolve, reject) => {
    const onMessage = message => { worker.off("error", onError); resolve(message); };
    const onError = error => { worker.off("message", onMessage); reject(error); };
    worker.once("message", onMessage); worker.once("error", onError); worker.postMessage(body);
  });
  try {
    const input = { people: original, links: [], mode: "generations", reverse: false };
    const before = await send({ requestId: 1, ...input });
    assert.equal(before.error, undefined); assert.equal(before.updateKind, "full");
    const dated = { ...input, people: original.map(p => p.id === "c" ? { ...p, birth: "1932" } : p) };
    const retained = await send({ requestId: 2, ...dated, previousInput: input, previousGeometry: before.geometry });
    assert.equal(retained.updateKind, "retained"); assert.deepEqual(retained.geometry, before.geometry);
    const added = { ...dated, people: [...dated.people, { id: "d", birth: "1940", parents: ["a", "b"], spouses: [] }] };
    const local = await send({ requestId: 3, ...added, previousInput: dated, previousGeometry: retained.geometry });
    assert.equal(local.error, undefined); assert.equal(local.updateKind, "local");
    assert.deepEqual(local.geometry.positions.filter(([id]) => id !== "d"), before.geometry.positions);
    assert.ok(local.geometry.branches.some(b => b.target === "d" && b.relations.length === 2));
    const removed = await send({ requestId: 4, ...dated, previousInput: added, previousGeometry: local.geometry });
    assert.equal(removed.updateKind, "local"); assert.deepEqual(removed.geometry.positions, before.geometry.positions);
    const family = { ...dated, people: [...dated.people.map(p => p.id === "c" ? { ...p, spouses: ["new-spouse"] } : p),
      { id: "new-spouse", birth: "1930", parents: [], spouses: ["c"] },
      ...[1, 2].map(i => ({ id: `new-child-${i}`, birth: "1960", parents: ["c", "new-spouse"], spouses: [] }))] };
    const grown = await send({ requestId: 5, ...family, previousInput: dated, previousGeometry: retained.geometry });
    assert.equal(grown.error, undefined); assert.equal(grown.updateKind, "local");
    assert.deepEqual(grown.geometry.positions.filter(([id]) => dated.people.some(p => p.id === id)), before.geometry.positions);
    assert.equal(grown.geometry.occurrences.length, family.people.length);
    // Moving an existing child to another parent still requires a complete solve.
    const structural = { ...family, people: family.people.map(p => p.id === "c" ? { ...p, parents: ["a"] } : p) };
    const full = await send({ requestId: 6, ...structural, previousInput: family, previousGeometry: grown.geometry });
    assert.equal(full.error, undefined); assert.equal(full.updateKind, "full");
    assert.equal(full.geometry.occurrences.length, structural.people.length);
    const cold = await send({ requestId: 7, ...structural });
    assert.deepEqual(full.geometry, cold.geometry);
  } finally { await worker.terminate(); }
});
test("production Worker preserves horizontal history for a small ancestor insertion beyond 200 people", { timeout: 20_000 }, async () => {
  const worker = productionWorker();
  const send = body => new Promise((resolve, reject) => {
    const onMessage = message => { worker.off("error", onError); resolve(message); };
    const onError = error => { worker.off("message", onMessage); reject(error); };
    worker.once("message", onMessage); worker.once("error", onError); worker.postMessage(body);
  });
  try {
    for (const reverse of [false, true]) {
      const people = [{ id: "root", birth: "1900", parents: [], spouses: [] },
        { id: "child", birth: "1930", parents: ["root"], spouses: [] },
        ...Array.from({ length: 220 }, (_, i) => ({ id: `separate-${i}`, birth: "", parents: [], spouses: [] }))];
      const input = { people, links: [], mode: "generations", reverse };
      const before = await send({ requestId: 81, ...input });
      assert.equal(before.error, undefined);
      const edited = { ...input, people: [...people.map(p => p.id === "root" ? { ...p, parents: ["ancestor"] } : p),
        { id: "ancestor", birth: "1870", parents: [], spouses: [] }] };
      const after = await send({ requestId: 82, ...edited, previousInput: input, previousGeometry: before.geometry });
      assert.equal(after.error, undefined);
      assert.equal(after.updateKind, "full");
      assert.equal(after.geometry.positions.length, edited.people.length);
      const positions = new Map(after.geometry.positions);
      for (const [id, p] of before.geometry.positions) assert.equal(positions.get(id).x, p.x, id);
    }
  } finally { await worker.terminate(); }
});

test("production worker refines an explicit displayed geometry without dropping people or generations", { timeout: 20_000 }, async () => {
  const worker = productionWorker();
  try {
    const geometry = await calculate(worker, "generations", false, people, "portrait");
    const snapshot = structuredClone(geometry);
    const result = await new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", message => { worker.off("error", reject); resolve(message); });
      worker.postMessage({ requestId: 915, people, links: [], mode: "generations", reverse: false,
        previousGeometry: geometry, optimizeDisplayed: true });
    });
    assert.equal(result.requestId, 915);
    assert.equal(result.error, undefined);
    assert.equal(typeof result.optimization.changed, "boolean");
    assert.deepEqual(new Map(result.geometry.positions.map(([id, p]) => [id, p.y])),
      new Map(geometry.positions.map(([id, p]) => [id, p.y])));
    assert.deepEqual(result.geometry.occurrences, geometry.occurrences);
    assert.ok(result.optimization.after.crossings <= result.optimization.before.crossings);
    assert.ok(result.optimization.after.contacts <= result.optimization.before.contacts);
    assert.deepEqual(geometry, snapshot);
  } finally { await worker.terminate(); }
});

test("production Worker packs a displayed scene while preserving households and card size", { timeout: 10000 }, async () => {
  const worker = productionWorker();
  try {
    const { input, geometry } = crowdedFamily(205);
    const result = await new Promise((resolve, reject) => {
      const onError = error => { worker.off("message", onMessage); reject(error); };
      const onMessage = message => { worker.off("error", onError); resolve(message); };
      worker.once("message", onMessage); worker.once("error", onError);
      worker.postMessage({ requestId: 916, ...input, mode: "generations", reverse: false,
        previousGeometry: geometry, optimizeDisplayed: true, layoutGoal: "compact" });
    });
    assert.equal(result.error, undefined); assert.equal(result.optimization.changed, true);
    assert.deepEqual(result.geometry.occurrences, geometry.occurrences);
    assert.deepEqual(result.geometry.nodeSize, geometry.nodeSize);
    const points = new Map(result.geometry.positions);
    const extent = positions => Math.max(...positions.map(([, p]) => p.x)) - Math.min(...positions.map(([, p]) => p.x));
    assert.ok(extent(result.geometry.positions) < extent(geometry.positions));
    for (const [id, p] of geometry.positions) assert.equal(points.get(id).y, p.y);
    assert.equal(points.get("neighbor-partner").x - points.get("right-1").x, 252);
  } finally { await worker.terminate(); }
});

test("two ELK workers preserve the exact large-archive geometry and subsequent single-worker reuse", { timeout: 60_000 }, async () => {
  const data = randomFamily(5, 9);
  assert.equal(data.length, 977);
  const fingerprint = (geometry) => createHash("sha256").update(JSON.stringify(geometry)).digest("hex");
  const worker = productionWorker();
  try {
    const sequential = await calculate(worker, "generations", false, data, "portrait", false);
    assert.equal(sequential.error, undefined);
    const parallel = await calculate(worker, "generations", false, data, "portrait", true);
    assert.equal(parallel.error, undefined);
    assert.equal(fingerprint(parallel), fingerprint(sequential));
    assert.equal(fingerprint(await calculate(worker, "generations", false, data, "portrait", false)), fingerprint(sequential));
  } finally { await worker.terminate(); }
});
test(
  "production worker executes nested ELK and switches back to timeline",
  { timeout: 20000 },
  async () => {
    const worker = productionWorker();
    try {
      const g = await calculate(worker, "generations");
      assert.equal(g.error, undefined);
      assert.equal(g.blocks.length, 0);
      assert.equal(g.occurrences.length, 5);
      const couplePositions = new Map(g.positions);
      const commonX = couplePositions.get("a").x;
      assert.ok(
        (couplePositions.get("b").x - commonX) *
          (couplePositions.get("c").x - commonX) <
          0,
      );
      assert.equal(g.branches.length, 4);
      const portrait = await calculate(
        worker,
        "generations",
        false,
        people,
        "portrait",
      );
      assert.equal(portrait.error, undefined);
      assert.deepEqual(portrait.nodeSize, { width: 220, height: 264 });
      assert.equal(portrait.branches.length, g.branches.length);
      for (const [index, [, a]] of portrait.positions.entries())
        for (const [, b] of portrait.positions.slice(0, index))
          assert.ok(Math.abs(a.x - b.x) >= 220 || Math.abs(a.y - b.y) >= 264);
      const timeline = await calculate(worker, "timeline");
      assert.equal(timeline.error, undefined);
      assert.equal(timeline.positions.length, g.positions.length);
      assert.equal(timeline.branches.length, g.branches.length);
      assert.equal(timeline.coveredRelations.length, 6);
      const reverse = await calculate(worker, "generations", true);
      assert.equal(reverse.error, undefined);
      assert.equal(reverse.reverse, true);
      assert.equal(reverse.branches.length, g.branches.length);
      // Reusing the ELK engine must not retain mode/direction from the last job.
      assert.deepEqual(await calculate(worker, "generations"), g);
      const broad = [{ id: "root", birth: "1900", parents: [], spouses: [] }];
      for (let i = 0; i < 18; i++) {
        broad.push(
          {
            id: `child-${i}`,
            birth: "1930",
            parents: ["root"],
            spouses: [`spouse-${i}`],
          },
          {
            id: `spouse-${i}`,
            birth: "1930",
            parents: [],
            spouses: [`child-${i}`],
          },
        );
        for (let j = 0; j < 3; j++)
          broad.push({
            id: `grand-${i}-${j}`,
            birth: "1960",
            parents: [`child-${i}`, `spouse-${i}`],
            spouses: [],
          });
      }
      const packed = await calculate(worker, "generations", false, broad);
      assert.equal(packed.error, undefined);
      assert.equal(
        new Set(packed.occurrences.map((o) => o.personId)).size,
        broad.length,
      );
      const positions = new Map(packed.positions);
      for (const reversed of [false, true]) {
        const chronology = await calculate(worker, "timeline", reversed, broad);
        assert.equal(chronology.error, undefined);
        assert.equal(chronology.occurrences.length, packed.occurrences.length);
        assert.equal(chronology.branches.length, packed.branches.length);
        const dated = new Map(chronology.positions);
        for (const p of broad)
          assert.equal(
            dated.get(p.id).y,
            60 +
              (reversed ? 2035 - Number(p.birth) : Number(p.birth) - 1830) * 8,
          );
      }
      assert.equal(packed.generationBands.length, 3);
      for (const band of packed.generationBands) {
        for (const id of band.members) {
          const y = positions.get(id).y;
          assert.ok(y >= band.minY && y <= band.maxY);
        }
      }
      const focusedIds = new Set([
        "child-0",
        "spouse-0",
        "grand-0-0",
        "grand-0-1",
        "grand-0-2",
      ]);
      const project = (ids) =>
        broad
          .filter((p) => ids.has(p.id))
          .map((p) => ({
            ...p,
            parents: p.parents.filter((id) => ids.has(id)),
            spouses: p.spouses.filter((id) => ids.has(id)),
          }));
      const focused = await calculate(
        worker,
        "generations",
        false,
        project(focusedIds),
      );
      assert.equal(focused.error, undefined);
      assert.deepEqual(
        new Set(focused.occurrences.map((o) => o.personId)),
        focusedIds,
      );
      focusedIds.add("root");
      const expanded = await calculate(
        worker,
        "generations",
        false,
        project(focusedIds),
      );
      assert.equal(expanded.error, undefined);
      assert.deepEqual(
        new Set(expanded.occurrences.map((o) => o.personId)),
        focusedIds,
      );
      const restored = await calculate(worker, "generations", false, broad);
      assert.equal(restored.error, undefined);
      assert.deepEqual(
        new Set(restored.occurrences.map((o) => o.personId)),
        new Set(broad.map((p) => p.id)),
      );
    } finally {
      await worker.terminate();
    }
  },
);
