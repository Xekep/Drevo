import ELK from "elkjs/lib/elk.bundled.js";
import { randomFamily } from "../../../tests/layout-fixtures.ts";
import { treeNodeSize } from "../../../src/domain/tree-layout-constants.ts";
import { unionGeometry } from "../../../src/domain/union-layout.ts";
import { routingQuality } from "../../../src/domain/routing-quality.ts";
for (const [seed, generations] of [
  [1, 2],
  [1, 4],
  [5, 5],
  [5, 9],
]) {
  const people = randomFamily(seed, generations);
  let calls = 0,
    elkMs = 0;
  const start = performance.now();
  const geometry = await unionGeometry(
    people,
    async (graph) => {
      calls++;
      const s = performance.now();
      const result = await new ELK({ algorithms: ["layered"] }).layout(graph);
      elkMs += performance.now() - s;
      return result;
    },
    false,
    [],
    treeNodeSize(),
  );
  const layoutMs = performance.now() - start;
  const q = routingQuality(
    geometry.branches.map((b) => ({ group: b.union, route: b.route })),
  );
  console.log(
    JSON.stringify({
      seed,
      generations,
      people: people.length,
      layoutMs: Math.round(layoutMs),
      elkMs: Math.round(elkMs),
      elkCalls: calls,
      crossings: q.crossings,
      contacts: q.contacts,
      missingPeople: people.length - geometry.positions.length,
      nonFinitePositions: geometry.positions.filter(
        ([, p]) => !Number.isFinite(p.x) || !Number.isFinite(p.y),
      ).length,
      rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2),
    }),
  );
}
