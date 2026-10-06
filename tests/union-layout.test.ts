import test from "node:test";
import assert from "node:assert/strict";
import {
  branchContactCounts,
  familyUnions,
  unionGeometry as calculateUnions,
  type UnionBranch,
} from "../src/domain/union-layout.ts";
import ELK from "elkjs/lib/elk.bundled.js";
import type { FamilyLink } from "../src/domain/types.ts";
import { crossingPaths } from "../src/domain/route-crossings.ts";
import { segmentHitsBox } from "../src/domain/edge-routing.ts";
import { segmentsCross } from "../src/domain/layout-order.ts";
import type { ElkNode } from "elkjs";
import type { LayoutPerson, TreeGeometry } from "../src/domain/tree-layout.ts";
import {
  treeNodeSize,
  TREE_NODE_HEIGHT,
} from "../src/domain/tree-layout-constants.ts";
import {
  editedAncestorFamily,
  editedFamily,
  randomFamily,
} from "./layout-fixtures.ts";
const unionGeometry = (
  people: LayoutPerson[],
  reverse = false,
  links: Pick<FamilyLink, "type" | "from" | "to">[] = [],
  previous?: TreeGeometry,
) =>
  calculateUnions(
    people,
    (graph) => new ELK({ algorithms: ["layered"] }).layout(graph),
    reverse,
    links,
    undefined,
    previous,
  );
const person = (
  id: string,
  parents: string[] = [],
  spouses: string[] = [],
): LayoutPerson => ({ id, parents, spouses, birth: "" });

test("asymmetric partner ancestry keeps siblings and their direct parents on the right floors", async () => {
  const people = [
    person("parent"),
    person("a", ["parent"], ["partner"]),
    person("b", ["parent"]),
    person("partner", ["partner-parent"], ["a"]),
    person("partner-parent", ["grandparent"]),
    person("grandparent", ["great"]),
    person("great"),
  ];
  const before = structuredClone(people);
  for (const reverse of [false, true]) {
    const g = await unionGeometry(people, reverse);
    verify(people, g);
    const bands = new Map(
      g.generationBands!.flatMap((band) =>
        band.members.map((id) => [id, band.level]),
      ),
    );
    assert.equal(bands.get("a"), bands.get("b"));
    assert.equal(bands.get("a"), bands.get("partner"));
    assert.equal(bands.get("a")! - bands.get("parent")!, 1);
    const positions = new Map(g.positions);
    assert.ok(Math.abs(positions.get("a")!.y - positions.get("b")!.y) <= 60);
    assert.equal(positions.get("a")!.y, positions.get("partner")!.y);
  }
  assert.deepEqual(people, before);
});

test("a godparent route does not change card placement or primary branch geometry", async () => {
  const people = randomFamily(1, 2),
    size = treeNodeSize();
  const calculate = (links: Pick<FamilyLink, "type" | "from" | "to">[]) =>
    calculateUnions(
      people,
      (graph) => new ELK({ algorithms: ["layered"] }).layout(graph),
      false,
      links,
      size,
    );
  const plain = await calculate([]);
  const withExtra = await calculate([
    { type: "godparent", from: people[0].id, to: people.at(-1)!.id },
  ]);
  assert.deepEqual(withExtra.positions, plain.positions);
  assert.deepEqual(withExtra.branches, plain.branches);
  assert.equal(withExtra.routes!.length, 1);
  verify(people, withExtra);
});

test("a shared contact at a segment joint counts once when choosing a layout", () => {
  const branch = (
    union: string,
    points: { x: number; y: number }[],
  ): UnionBranch => ({
    id: union,
    source: union,
    target: union,
    union,
    relations: [],
    route: { sourceHandle: "bottom", targetHandle: "top", points },
  });
  assert.deepEqual(
    branchContactCounts([
      branch("family-a", [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]),
      branch("family-b", [
        { x: 50, y: -10 },
        { x: 50, y: 0 },
        { x: 50, y: 10 },
      ]),
    ]),
    { distinct: 1, segments: 2 },
  );
});

test("a couple may reverse when its parent families arrive in opposite order", async () => {
  const people = randomFamily(3, 2);
  const size = treeNodeSize();
  const seenSeeds = new Set<string>();
  const baseline = await calculateUnions(
    people,
    async (graph) => {
      const seed = graph.layoutOptions?.["elk.randomSeed"] || "";
      if (seenSeeds.has(seed)) throw new Error("skip alternative couple order");
      seenSeeds.add(seed);
      return new ELK({ algorithms: ["layered"] }).layout(graph);
    },
    false,
    [],
    size,
  );
  const improved = await calculateUnions(
    people,
    (graph) => new ELK({ algorithms: ["layered"] }).layout(graph),
    false,
    [],
    size,
  );
  const before = new Map(baseline.positions);
  const after = new Map(improved.positions);
  const reversed = (improved.blocks || []).filter(
    (block) =>
      block.members.length === 2 &&
      Math.sign(
        before.get(block.members[0])!.x - before.get(block.members[1])!.x,
      ) !==
        Math.sign(
          after.get(block.members[0])!.x - after.get(block.members[1])!.x,
        ),
  );
  assert.ok(reversed.length > 0);
  assert.ok(
    branchContactCounts(improved.branches || []).distinct <=
      branchContactCounts(baseline.branches || []).distinct,
  );
  verify(people, improved);
});

test("small trees refine individual couples after choosing an ELK layout", async () => {
  const people = randomFamily(1, 2);
  let elkCalls = 0;
  const geometry = await calculateUnions(
    people,
    (graph) => {
      elkCalls++;
      return new ELK({ algorithms: ["layered"] }).layout(graph);
    },
    false,
    [],
    treeNodeSize(),
  );
  assert.equal(elkCalls, 7);
  assert.equal(branchContactCounts(geometry.branches || []).distinct, 16);
  verify(people, geometry);
});

test("adding a founder's parent preserves the previous horizontal family order", async () => {
  const original = randomFamily(6);
  const edited = editedAncestorFamily(original, 6);
  const before = await unionGeometry(original);
  const plain = await unionGeometry(edited);
  const incremental = await unionGeometry(edited, false, [], before);
  const drift = (current: TreeGeometry, axis: "x" | "y") => {
    const old = new Map(before.positions);
    const shifts = current.positions
      .filter(([id]) => old.has(id))
      .map(([id, point]) => point[axis] - old.get(id)![axis])
      .sort((a, b) => a - b);
    const center = shifts[Math.floor(shifts.length / 2)];
    return (
      shifts.reduce((sum, shift) => sum + Math.abs(shift - center), 0) /
      shifts.length
    );
  };

  verify(edited, incremental);
  assert.ok(drift(incremental, "x") < drift(plain, "x") * 0.3);
  assert.ok(drift(incremental, "y") <= Math.max(drift(plain, "y"), 32) + 32);
  const plainContacts = branchContactCounts(plain.branches || []).distinct;
  const incrementalContacts = branchContactCounts(
    incremental.branches || [],
  ).distinct;
  assert.ok(incrementalContacts <= plainContacts + 1);
  if (incrementalContacts > plainContacts)
    assert.ok(drift(incremental, "x") < drift(plain, "x") * 0.1);
});

test("an ancestor edit keeps existing couples from flipping for a local gain", async () => {
  const original = randomFamily(5, 2);
  const before = await unionGeometry(original);
  const edited = editedAncestorFamily(original, 5);
  const after = await unionGeometry(edited, false, [], before);
  const old = new Map(before.positions),
    next = new Map(after.positions);
  const reversed = (before.blocks || []).filter(
    (block) =>
      block.members.length === 2 &&
      block.members.every((id) => next.has(id)) &&
      Math.sign(old.get(block.members[0])!.x - old.get(block.members[1])!.x) !==
        Math.sign(
          next.get(block.members[0])!.x - next.get(block.members[1])!.x,
        ),
  );
  assert.ok(reversed.length <= 2);
  verify(edited, after);
});

test("incremental ordering also protects edited families above one hundred people", async () => {
  for (const [seed, edit] of [
    [1, editedAncestorFamily],
    [5, editedFamily],
  ] as const) {
    const original = randomFamily(seed, 4);
    const edited = edit(original, seed);
    assert.ok(original.length > 100 && edited.length <= 200);
    const before = await unionGeometry(original);
    const plain = await unionGeometry(edited);
    const incremental = await unionGeometry(edited, false, [], before);
    const old = new Map(before.positions);
    const drift = (current: TreeGeometry) => {
      const shifts = current.positions
        .filter(([id]) => old.has(id))
        .map(([id, point]) => point.x - old.get(id)!.x)
        .sort((a, b) => a - b);
      const center = shifts[Math.floor(shifts.length / 2)];
      return (
        shifts.reduce((sum, shift) => sum + Math.abs(shift - center), 0) /
        shifts.length
      );
    };
    verify(edited, incremental);
    assert.ok(drift(incremental) < drift(plain) * 0.2);
    assert.ok(
      branchContactCounts(incremental.branches || []).distinct <=
        branchContactCounts(plain.branches || []).distinct,
    );
  }
});

test("the final family routes decide between layouts within the same bands", async () => {
  const people = [
    person("root"),
    person("a", ["root"]),
    person("b", ["root"]),
    person("ca", ["a"]),
    person("cb", ["b"]),
  ];
  const seeds: string[] = [];
  const geometry = await calculateUnions(people, async (graph: ElkNode) => {
    const seed = graph.layoutOptions?.["elk.randomSeed"] || "";
    seeds.push(seed);
    const crossed = seed === "1";
    const children = graph.children!.map((node) => ({
      ...node,
      x: node.id.includes('"root"')
        ? 200
        : node.id.includes('"a"')
          ? 0
          : node.id.includes('"b"')
            ? 400
            : node.id.includes('"ca"')
              ? crossed
                ? 400
                : 0
              : crossed
                ? 0
                : 400,
      y: Number(node.layoutOptions!["elk.partitioning.partition"]) * 300,
    }));
    const ports = new Map(
      children.flatMap((n) =>
        n.ports!.map((p) => [p.id, { x: n.x + p.x!, y: n.y + p.y! }]),
      ),
    );
    return {
      ...graph,
      children,
      edges: graph.edges!.map((edge, i) => {
        const startPoint = ports.get(edge.sources[0])!,
          endPoint = ports.get(edge.targets[0])!;
        const y = startPoint.y + 40 + i * 12;
        return {
          ...edge,
          sections: [
            {
              id: `${edge.id}:section`,
              startPoint: { ...startPoint },
              endPoint: { ...endPoint },
              bendPoints: [
                { x: startPoint.x, y },
                { x: endPoint.x, y },
              ],
            },
          ],
        };
      }),
    };
  });
  assert.deepEqual(seeds, ["1", "15"]);
  const p = new Map(geometry.positions);
  assert.equal(p.get("ca")!.x, p.get("a")!.x);
  verify(people, geometry);
});

test("terminal siblings share one generation band without folding into lower generations", async () => {
  const children = Array.from({ length: 12 }, (_, i) => ({
    ...person(`child-${i}`, ["a", "b"]),
    birth: String(1950 + i),
  }));
  const people = [person("a", [], ["b"]), person("b", [], ["a"]), ...children];
  const before = structuredClone(people);
  for (const reverse of [false, true]) {
    const g = await unionGeometry(people, reverse);
    verify(people, g);
    const positions = new Map(g.positions),
      parent = positions.get("a")!;
    assert.equal(g.siblingGroups!.length, 0);
    assert.equal(g.generationBands!.length, 2);
    const band = g.generationBands![1];
    assert.deepEqual(
      [...band.members].sort(),
      children.map((c) => c.id).sort(),
    );
    for (const child of children) {
      const y = positions.get(child.id)!.y;
      assert.ok(Math.abs(y - parent.y) >= 150);
      assert.ok(reverse ? y < parent.y : y > parent.y);
    }
    assert.ok(
      positions.get("child-0")!.x < positions.get("child-1")!.x,
      "known birth dates order terminal siblings",
    );
  }
  assert.deepEqual(people, before);
});

test("122 people preserve three readable generation bands and compact vertical spacing", async () => {
  const people = [person("a", [], ["b"]), person("b", [], ["a"])];
  for (let i = 0; i < 24; i++) {
    people.push(
      person(`c${i}`, ["a", "b"], [`s${i}`]),
      person(`s${i}`, [], [`c${i}`]),
    );
    for (let j = 0; j < 3; j++)
      people.push(person(`g${i}-${j}`, [`c${i}`, `s${i}`]));
  }
  const g = await unionGeometry(people);
  verify(people, g);
  const positions = new Map(g.positions);
  assert.equal(g.generationBands!.length, 3);
  assert.ok(
    Math.max(...g.positions.map(([, p]) => p.y)) -
      Math.min(...g.positions.map(([, p]) => p.y)) +
      TREE_NODE_HEIGHT <=
      500,
  );
  for (let i = 0; i < 24; i++) {
    assert.equal(positions.get(`c${i}`)!.y, positions.get(`s${i}`)!.y);
    const y = positions.get(`g${i}-0`)!.y;
    for (let j = 1; j < 3; j++) assert.equal(positions.get(`g${i}-${j}`)!.y, y);
  }
});
function verify(people: LayoutPerson[], g: TreeGeometry) {
  const { width, height } = g.nodeSize ?? treeNodeSize();
  const occurrences = new Map(g.occurrences!.map((o) => [o.id, o.personId]));
  assert.deepEqual(
    [...new Set(occurrences.values())].sort(),
    people.map((p) => p.id).sort(),
  );
  assert.equal(occurrences.size, g.positions.length);
  const actual = new Set(
    g.branches!.flatMap((b) =>
      b.relations.map((r) => JSON.stringify([r.type, r.from, r.to])),
    ),
  );
  const expected = new Set(
    people.flatMap((p) => [
      ...p.parents.map((from) => JSON.stringify(["parent", from, p.id])),
      ...p.spouses.map((id) =>
        JSON.stringify(["spouse", ...[p.id, id].sort()]),
      ),
    ]),
  );
  assert.deepEqual(actual, expected);
  const bands = new Map(
    g.generationBands!.flatMap((band) =>
      band.members.map((id) => [id, band] as const),
    ),
  );
  assert.equal(bands.size, g.positions.length);
  for (const [id, p] of g.positions) {
    const band = bands.get(id)!;
    assert.ok(
      p.y >= band.minY && p.y <= band.maxY,
      `${id} left its generation band`,
    );
    assert.equal(band.maxY - band.minY, 60);
  }
  for (const branch of g.branches!.filter((b) => b.id.startsWith("child:")))
    assert.ok(
      bands.get(branch.source)!.level < bands.get(branch.target)!.level,
      "parents precede children semantically in either direction",
    );
  for (let i = 0; i < g.positions.length; i++)
    for (let j = 0; j < i; j++) {
      const a = g.positions[i][1],
        b = g.positions[j][1];
      assert.ok(
        Math.abs(a.x - b.x) >= width || Math.abs(a.y - b.y) >= height,
        "overlapping cards",
      );
    }
  for (const b of g.branches!) {
    assert.ok(occurrences.has(b.source) && occurrences.has(b.target));
    for (let i = 1; i < b.route.points.length; i++) {
      const a = b.route.points[i - 1],
        c = b.route.points[i];
      assert.ok(a.x === c.x || a.y === c.y, "orthogonal route");
      for (const [id, p] of g.positions)
        assert.equal(
          segmentHitsBox(a, c, {
            left: p.x,
            top: p.y,
            right: p.x + width,
            bottom: p.y + height,
          }),
          false,
          `${b.id} crosses card ${id}`,
        );
    }
  }
}
test("three marriages and a former spouse's new family remain four exact unions", async () => {
  const people = [
    person("a", [], ["b", "c", "d"]),
    person("b", [], ["a", "e"]),
    person("c"),
    person("d"),
    person("e"),
    person("ab", ["a", "b"]),
    person("ab2", ["a", "b"]),
    person("ac", ["a", "c"]),
    person("ac2", ["a", "c"]),
    person("ad", ["a", "d"]),
    person("ad2", ["a", "d"]),
    person("be", ["b", "e"]),
    person("be2", ["b", "e"]),
  ];
  const before = structuredClone(people);
  assert.equal(familyUnions(people).length, 4);
  for (const reverse of [false, true]) {
    const g = await unionGeometry(people, reverse);
    verify(people, g);
    assert.equal(g.blocks!.length, 0);
    assert.equal(g.branches!.filter((b) => b.id.startsWith("pair:")).length, 4);
    assert.equal(g.occurrences!.length, people.length);
  }
  assert.deepEqual(people, before);
});
test("a child with one known parent is not assigned to that parent's marriage", async () => {
  const people = [person("a", [], ["b"]), person("b"), person("child", ["a"])];
  const g = await unionGeometry(people);
  verify(people, g);
  assert.equal(g.occurrences!.length, people.length);
  const branch = g.branches!.find((b) =>
    b.relations.some((r) => r.to === "child"),
  )!;
  assert.deepEqual(branch.relations, [
    { from: "a", to: "child", type: "parent" },
  ]);
});

test("two spouses flank one shared parent and half-siblings keep distinct family junctions", async () => {
  const people = [
    person("parent", [], ["one", "two"]),
    person("one"),
    person("two"),
    person("first-a", ["parent", "one"]),
    person("first-b", ["parent", "one"]),
    person("second-a", ["parent", "two"]),
    person("second-b", ["parent", "two"]),
  ];
  for (const variant of ["classic", "portrait"] as const)
    for (const reverse of [false, true]) {
      const g = await calculateUnions(
        people,
        (graph) => new ELK().layout(graph),
        reverse,
        [],
        variant === "portrait" ? treeNodeSize() : { width: 220, height: 84 },
      );
      verify(people, g);
      assert.equal(g.occurrences!.length, people.length);
      assert.equal(g.blocks!.length, 0);
      const p = new Map(g.positions),
        center = p.get("parent")!;
      assert.ok(
        (p.get("one")!.x - center.x) * (p.get("two")!.x - center.x) < 0,
      );
      assert.equal(p.get("one")!.y, center.y);
      assert.equal(p.get("two")!.y, center.y);
      const first = g.branches!.filter(
        (b) =>
          b.id.startsWith("child:") &&
          b.relations.some((r) => r.from === "one"),
      );
      const second = g.branches!.filter(
        (b) =>
          b.id.startsWith("child:") &&
          b.relations.some((r) => r.from === "two"),
      );
      assert.equal(first.length, 2);
      assert.equal(second.length, 2);
      assert.deepEqual(first[0].route.points[0], first[1].route.points[0]);
      assert.deepEqual(second[0].route.points[0], second[1].route.points[0]);
      assert.notDeepEqual(first[0].route.points[0], second[0].route.points[0]);
      const firstXs = first.map((b) => p.get(b.target)!.x),
        secondXs = second.map((b) => p.get(b.target)!.x);
      assert.ok(
        Math.max(...firstXs) < Math.min(...secondXs) ||
          Math.max(...secondXs) < Math.min(...firstXs),
        "half-sibling families remain contiguous",
      );
      assert.equal(
        Math.sign(p.get("one")!.x - p.get("two")!.x),
        Math.sign(firstXs[0] - secondXs[0]),
      );
    }
});

test("many partners reserve local routing space while retaining every exact pair", async () => {
  const spouses = Array.from({ length: 8 }, (_, i) => `spouse-${i}`);
  const people = [
    person("parent", [], spouses),
    ...spouses.map((id) => person(id)),
    ...spouses.map((id, i) => person(`child-${i}`, ["parent", id])),
  ];
  for (const reverse of [false, true]) {
    const g = await unionGeometry(people, reverse);
    verify(people, g);
    assert.equal(g.occurrences!.length, people.length);
    assert.equal(g.blocks!.length, 0);
    const junctions = g
      .branches!.filter((b) => b.id.startsWith("child:"))
      .map((b) => b.route.points[0].x);
    assert.equal(new Set(junctions).size, spouses.length);
    const p = new Map(g.positions),
      center = p.get("parent")!.x;
    assert.equal(spouses.filter((id) => p.get(id)!.x < center).length, 4);
    assert.equal(spouses.filter((id) => p.get(id)!.x > center).length, 4);
  }
});

test("a shared parent retains all ancestral branches of both spouses", async () => {
  const people = [
    person("gp"),
    person("ga"),
    person("gb"),
    person("parent", ["gp"], ["one", "two"]),
    person("one", ["ga"]),
    person("two", ["gb"]),
    person("first", ["parent", "one"]),
    person("second", ["parent", "two"]),
  ];
  const g = await unionGeometry(people);
  verify(people, g);
  assert.equal(g.occurrences!.length, people.length);
});

test("co-parents keep separate card backgrounds while spouses share one", async () => {
  const child = person("child", ["a", "b"]);
  for (const reverse of [false, true]) {
    const coParents = await unionGeometry(
      [person("a"), person("b"), child],
      reverse,
    );
    assert.equal(coParents.blocks!.length, 0);
    const coParentPair = coParents.branches!.find((branch) =>
      branch.id.startsWith("pair:"),
    );
    assert.ok(coParentPair);
    assert.deepEqual(
      coParentPair.relations.map((relation) => relation.type),
      ["parent", "parent"],
    );

    const married = await unionGeometry(
      [person("a", [], ["b"]), person("b", [], ["a"]), child],
      reverse,
    );
    assert.equal(married.blocks!.length, 1);
    assert.deepEqual(married.blocks![0].members, ["a", "b"]);
    assert.deepEqual(
      married.branches!.find((branch) => branch.id.startsWith("pair:"))!
        .relations,
      [{ from: "a", to: "b", type: "spouse" }],
    );
  }
});
test("shared parent branch has one route per child and no crossing in a nuclear family", async () => {
  const people = [
    person("a"),
    person("b"),
    person("one", ["a", "b"]),
    person("two", ["a", "b"]),
    person("three", ["a", "b"]),
  ];
  const g = await unionGeometry(people);
  verify(people, g);
  const children = g.branches!.filter((b) => b.id.startsWith("child:"));
  assert.equal(children.length, 3);
  assert.ok(children.every((b) => b.relations.length === 2));
  for (const b of children) {
    const points = b.route.points,
      start = points[0],
      end = points.at(-1)!;
    const distance = points
      .slice(1)
      .reduce(
        (sum, p, i) =>
          sum + Math.abs(p.x - points[i].x) + Math.abs(p.y - points[i].y),
        0,
      );
    assert.equal(
      distance,
      Math.abs(end.x - start.x) + Math.abs(end.y - start.y),
      "first-row children do not detour through the outer family trunk",
    );
  }
  assert.deepEqual(
    children.map((b) => b.route.points[0]),
    Array(3).fill(children[0].route.points[0]),
  );
  for (const a of children)
    for (const b of children)
      if (a !== b)
        for (let i = 1; i < a.route.points.length; i++)
          for (let j = 1; j < b.route.points.length; j++)
            assert.equal(
              segmentsCross(
                [a.route.points[i - 1], a.route.points[i]],
                [b.route.points[j - 1], b.route.points[j]],
              ),
              false,
            );
});
test("unequal ancestry aligns a couple and connects both ancestral families", async () => {
  const people = [
    person("a0"),
    person("a", ["a0"], ["b"]),
    person("b0"),
    person("b1", ["b0"]),
    person("b", ["b1"]),
    person("child", ["a", "b"]),
  ];
  const g = await unionGeometry(people);
  verify(people, g);
  const p = new Map(g.positions);
  assert.equal(p.get("a")!.y, p.get("b")!.y);
  for (const person of people)
    for (const parent of person.parents)
      assert.ok(p.get(person.id)!.y > p.get(parent)!.y);
});
test("a union cycle caused by intermarriage keeps all ancestry through explicit occurrences", async () => {
  const people = [
    person("a", [], ["c"]),
    person("b", ["a"]),
    person("c", ["b"]),
    person("d", ["a", "c"]),
  ];
  const g = await unionGeometry(people);
  verify(people, g);
  assert.ok(g.occurrences!.length > people.length);
});
test("reversed display reflects complete routes and keeps genealogical facts", async () => {
  const people = [person("a"), person("b"), person("c", ["a", "b"])];
  const normal = await unionGeometry(people),
    reverse = await unionGeometry(people, true);
  const maxY = Math.max(...normal.positions.map(([, p]) => p.y));
  assert.deepEqual(
    reverse.positions,
    normal.positions.map(([id, p]) => [id, { x: p.x, y: maxY - p.y }]),
  );
  verify(people, reverse);
});
test("gaps distinguish crossings of separate branches, preserving shared family junctions", () => {
  const route = (points: { x: number; y: number }[]) => ({
    sourceHandle: "bottom" as const,
    targetHandle: "top" as const,
    points,
  });
  const edges = [
    {
      id: "a",
      group: "family1",
      route: route([
        { x: 0, y: 50 },
        { x: 100, y: 50 },
      ]),
    },
    {
      id: "b",
      group: "family2",
      route: route([
        { x: 50, y: 0 },
        { x: 50, y: 100 },
      ]),
    },
  ];
  assert.equal(
    crossingPaths(edges).get("a"),
    "M 0 50 L 45 50 M 55 50 L 100 50",
  );
  assert.equal(
    crossingPaths(edges.map((e) => ({ ...e, group: "same" }))).size,
    0,
  );
});

test("large portrait layouts preserve the legacy geometry when generation ranks are supplied directly", async () => {
  const people = randomFamily(1, 5);
  assert.ok(people.length > 300);
  const before = structuredClone(people);
  const engine = new ELK({ algorithms: ["layered"] });
  let directCalls = 0;
  const direct = await calculateUnions(
    people,
    (graph) => {
      assert.equal(graph.layoutOptions!["elk.partitioning.activate"], "false");
      assert.equal(
        graph.layoutOptions!["elk.layered.layering.strategy"],
        "INTERACTIVE",
      );
      directCalls++;
      return engine.layout(graph);
    },
    false,
    [],
    treeNodeSize(),
  );
  const legacy = await calculateUnions(
    people,
    (graph) => {
      graph.layoutOptions!["elk.partitioning.activate"] = "true";
      graph.layoutOptions!["elk.layered.layering.strategy"] = "NETWORK_SIMPLEX";
      for (const node of graph.children!) {
        delete node.x;
        delete node.y;
      }
      return engine.layout(graph);
    },
    false,
    [],
    treeNodeSize(),
  );
  assert.ok(directCalls > 0);
  assert.deepEqual(direct, legacy);
  assert.deepEqual(people, before);
  verify(people, direct);
});

test("ten thousand generations remain bounded in recursion and retain every child", async () => {
  const people = Array.from({ length: 10000 }, (_, i) =>
    person(`deep-${i}`, i ? [`deep-${i - 1}`] : []),
  );
  const g = await unionGeometry(people);
  assert.equal(
    new Set(g.occurrences!.map((o) => o.personId)).size,
    people.length,
  );
  assert.equal(
    g.branches!.filter((b) => b.id.startsWith("child:")).length,
    people.length - 1,
  );
  assert.ok(
    g.positions.every(([, p]) => Number.isFinite(p.x) && Number.isFinite(p.y)),
  );
});

test("adoption and godparents do not create a biological union or lose their routes", async () => {
  const people = [
    person("a"),
    person("b"),
    person("child", ["a", "b"]),
    person("adopted"),
    person("godparent"),
  ];
  const links = [
    { from: "a", to: "adopted", type: "adoptive_parent" as const },
    { from: "godparent", to: "child", type: "godparent" as const },
  ];
  const before = structuredClone(people);
  const g = await unionGeometry(people, false, links);
  verify(people, g);
  assert.equal(g.routes!.length, 2);
  assert.deepEqual(people, before);
  const points = new Map(g.positions);
  assert.ok(points.get("adopted")!.y > points.get("a")!.y);
});

test("portrait cards reserve their full height for siblings, spouses and routed links in both directions", async () => {
  const people = [
    person("a", [], ["b", "c"]),
    person("b", [], ["a"]),
    person("c", [], ["a"]),
    ...Array.from({ length: 7 }, (_, i) => person(`child-${i}`, ["a", "b"])),
    person("other-child", ["a", "c"]),
  ];
  const before = structuredClone(people);
  for (const reverse of [false, true]) {
    const geometry = await calculateUnions(
      people,
      (graph) => new ELK({ algorithms: ["layered"] }).layout(graph),
      reverse,
      [],
      treeNodeSize(),
    );
    verify(people, geometry);
    assert.equal(geometry.nodeSize?.height, 264);
    for (const group of [...geometry.blocks!, ...geometry.siblingGroups!]) {
      const positions = new Map(geometry.positions);
      for (const id of group.members) {
        const position = positions.get(id)!;
        assert.ok(position.y >= group.y);
        assert.ok(
          position.y + geometry.nodeSize!.height <= group.y + group.height,
        );
      }
    }
  }
  assert.deepEqual(people, before);
});

test("families can shift inside one band while couples remain aligned", async () => {
  const people = [
    person("a"),
    person("leaf", ["a"]),
    person("b", ["a"], ["spouse"]),
    person("spouse"),
    person("c", ["b", "spouse"]),
    person("d", ["b", "spouse"]),
  ];
  for (const reverse of [false, true]) {
    const g = await unionGeometry(people, reverse);
    verify(people, g);
    const positions = new Map(g.positions);
    assert.notEqual(positions.get("leaf")!.y, positions.get("b")!.y);
    assert.equal(positions.get("b")!.y, positions.get("spouse")!.y);
    assert.deepEqual(
      new Set(g.generationBands![1].members),
      new Set(["leaf", "b", "spouse"]),
    );
  }
});

test("disconnected families, repeated marriages and isolates keep common generation bands", async () => {
  const people = [
    person("a0"),
    person("a", ["a0"], ["b", "c"]),
    person("b"),
    person("c"),
    person("ab", ["a", "b"]),
    person("ac", ["a", "c"]),
    person("other"),
    person("other-child", ["other"]),
    person("alone"),
  ];
  const g = await unionGeometry(people);
  verify(people, g);
  const bands = new Map(
    g.generationBands!.flatMap((b) => b.members.map((id) => [id, b.level])),
  );
  for (const o of g.occurrences!.filter((o) =>
    ["a", "b", "c", "other-child"].includes(o.personId),
  ))
    assert.equal(bands.get(o.id), 1);
  assert.equal(bands.get("ab"), 2);
  assert.equal(bands.get("ac"), 2);
  assert.equal(bands.get("alone"), 0);
});
