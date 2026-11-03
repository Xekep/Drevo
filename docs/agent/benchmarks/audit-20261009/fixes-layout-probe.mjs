// Each invocation is a fresh process; alternate before/after runs on an idle machine.
// DREVO_LAYOUT_BASELINE_ROOT points to a detached baseline worktree, never production.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ELK from "elkjs/lib/elk.bundled.js";
import { randomFamily } from "../../../tests/layout-fixtures.ts";
import { treeNodeSize } from "../../../src/domain/tree-layout-constants.ts";
import { routingQuality } from "../../../src/domain/routing-quality.ts";
const baseline = process.env.DREVO_LAYOUT_BASELINE_ROOT;
const { unionGeometry, createGeometryContactScorer } = await import(baseline
  ? pathToFileURL(join(baseline, "src/domain/union-layout.ts")).href
  : "../../../src/domain/union-layout.ts");
const people = randomFamily(5, 9), size = treeNodeSize();
let calls = 0, elkMs = 0;
const start = performance.now();
const geometry = await unionGeometry(people, async (graph) => {
  calls++;
  const began = performance.now();
  const result = await new ELK({ algorithms: ["layered"] }).layout(graph);
  elkMs += performance.now() - began;
  return result;
}, false, [], size);
const layoutMs = performance.now() - start;
const quality = routingQuality(geometry.branches.map((branch) => ({ group: branch.union, route: branch.route })));
const cards = createGeometryContactScorer(size.width, size.height);
console.log(JSON.stringify({ implementation: baseline ? "before-ce529f6" : "after-audit-fixes",
  fixture: "randomFamily(5,9)", people: people.length, layoutMs: Math.round(layoutMs), elkMs: Math.round(elkMs),
  domainMs: Math.round(layoutMs - elkMs), elkCalls: calls,
  crossings: quality.crossings, contacts: quality.contacts, cardHits: cards.cardContacts(geometry),
  overlaps: cards.cardOverlaps(geometry), missingPeople: people.length - geometry.positions.length,
  geometrySha256: createHash("sha256").update(JSON.stringify(geometry)).digest("hex"),
  node: process.version, platform: process.platform, productionDataUsed: false,
}));
