import test from "node:test";
import assert from "node:assert/strict";
import { familyNeighbors } from "../src/domain/family-neighborhood.ts";
import {
  treeFragment,
  fragmentContinuationWindow,
  FRAGMENT_PEOPLE_LIMIT,
  isFragmentThreshold,
} from "../src/domain/tree-fragment.ts";
import type { Person } from "../src/domain/types.ts";

const person = (id: string, parents: string[] = []): Person => ({
  id,
  name: id,
  surname: "",
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  parents,
  spouses: [],
  sources: [],
  column: 0,
  generation: 1,
});
const limits = {
  anchorId: "p5",
  ancestors: 3,
  descendants: 3,
  collateral: 0,
} as const;

test("full fragment windows expose every omitted sibling without a dialog or exceeding the layout budget", () => {
  const people = [
    person("parent"),
    ...Array.from({ length: 1500 }, (_, n) => person(`c${n}`, ["parent"])),
  ];
  const index = familyNeighbors({ people });
  const allowed = new Set(people.map((p) => p.id));
  const scoped = { ...limits, anchorId: "parent" };
  let projection = treeFragment(index, allowed, scoped);
  let visited = new Set<string>();
  const exposed = new Set(projection.visible);
  for (let page = 0; page < 3; page++) {
    const next = fragmentContinuationWindow(
      projection.continuations.get("parent")!,
      projection.visible,
      visited,
    );
    projection = treeFragment(
      index,
      allowed,
      scoped,
      new Set(),
      FRAGMENT_PEOPLE_LIMIT,
      next.priority,
    );
    visited = next.visited;
    assert.equal(projection.visible.size, FRAGMENT_PEOPLE_LIMIT);
    assert.ok(projection.visible.has("parent"));
    for (const id of projection.visible) exposed.add(id);
  }
  assert.equal(exposed.size, people.length);
  const restricted = new Set(["parent", "c0", "c1"]);
  const limited = treeFragment(index, restricted, scoped, new Set(), 500, [
    "c100",
    "c1",
  ]);
  assert.deepEqual(limited.visible, restricted);
  assert.equal(limited.hidden.size, 0);
});
test("fragments have explicit parent/child continuations, expand, collapse and can move through a deep tree", () => {
  const people = Array.from({ length: 20 }, (_, n) =>
    person(`p${n}`, n ? [`p${n - 1}`] : []),
  );
  const index = familyNeighbors({ people });
  const allowed = new Set(people.map((p) => p.id));
  const first = treeFragment(index, allowed, limits);
  assert.deepEqual([...first.visible].sort(), [
    "p2",
    "p3",
    "p4",
    "p5",
    "p6",
    "p7",
    "p8",
  ]);
  assert.deepEqual(first.continuations.get("p2")?.parents, ["p1"]);
  assert.deepEqual(first.continuations.get("p8")?.children, ["p9"]);
  const expanded = treeFragment(index, allowed, limits, new Set(["p8", "p9"]));
  assert.ok(expanded.visible.has("p10"));
  const collapsed = treeFragment(index, allowed, limits, new Set(["p9"]));
  assert.deepEqual(
    collapsed.visible,
    first.visible,
    "an expansion no longer connected to this fragment cannot pin an orphan",
  );
  const moved = treeFragment(index, allowed, { ...limits, anchorId: "p9" });
  assert.ok(moved.visible.has("p12"));
  assert.ok(!moved.visible.has("p2"));
});
test("wide and cyclic genealogy obeys the layout budget; a continuation lets every omitted child become an anchor", () => {
  const people = [
    person("parent"),
    ...Array.from({ length: 1500 }, (_, n) => person(`c${n}`, ["parent"])),
  ];
  const index = familyNeighbors({ people });
  const allowed = new Set(people.map((p) => p.id));
  const first = treeFragment(
    index,
    allowed,
    { ...limits, anchorId: "parent" },
    new Set(["parent"]),
  );
  assert.equal(first.visible.size, FRAGMENT_PEOPLE_LIMIT);
  assert.equal(first.continuations.get("parent")?.children.length, 1001);
  assert.equal(first.atLimit, true);
  const omitted = first.continuations.get("parent")!.children.at(-1)!;
  const moved = treeFragment(index, allowed, { ...limits, anchorId: omitted });
  assert.ok(moved.visible.has(omitted));
  assert.deepEqual(moved.visible, new Set([omitted, "parent"]));
  people[0].parents = ["c1499"];
  assert.ok(
    treeFragment(familyNeighbors({ people }), allowed, {
      ...limits,
      anchorId: "parent",
      ancestors: 7,
    }).visible.size <= FRAGMENT_PEOPLE_LIMIT,
  );
});
test("continuations and counters reveal neither filtered people nor additional links to unavailable people", () => {
  const people = [
    person("p5", ["secret"]),
    person("secret"),
    person("visible", ["p5"]),
  ];
  const index = familyNeighbors({
    people,
    links: [{ id: "link", from: "p5", to: "secret", type: "godparent" }],
  });
  const result = treeFragment(
    index,
    new Set(["p5", "visible"]),
    limits,
    new Set(["p5"]),
  );
  assert.deepEqual(result.visible, new Set(["p5", "visible"]));
  assert.equal(result.hidden.size, 0);
  assert.equal(result.continuations.size, 0);
  for (const invalid of [-1, 1, 99, 10001, NaN, Infinity, 500.5, "500", null])
    assert.equal(isFragmentThreshold(invalid), false);
  for (const valid of [0, 100, 250, 500, 10000])
    assert.equal(isFragmentThreshold(valid), true);
});
