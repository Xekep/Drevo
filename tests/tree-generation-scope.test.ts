import test from "node:test";
import assert from "node:assert/strict";
import { generationScope } from "../src/domain/tree-generation-scope.ts";
import {
  familyNeighbors,
  projectTree,
} from "../src/domain/family-neighborhood.ts";
import type { Person } from "../src/domain/types.ts";
import type { TreeGenerationLimits } from "../src/domain/tree-preferences.ts";

const person = (
  id: string,
  parents: string[] = [],
  spouses: string[] = [],
): Person => ({
  id,
  name: id,
  surname: "",
  patronymic: "",
  birth: "",
  birthPlace: "",
  sex: "u",
  parents,
  spouses,
  sources: [],
  column: 0,
  generation: 1,
});
const limits: TreeGenerationLimits = {
  anchorId: "main",
  ancestors: 3,
  descendants: 1,
  collateral: 0,
};
const people = [
  person("oldest"),
  person("great", ["oldest"]),
  person("grand", ["great"]),
  person("father", ["grand"]),
  person("mother"),
  person("uncle", ["grand"]),
  person("cousin", ["uncle"]),
  person("cousin-child", ["cousin"]),
  person("main", ["father", "mother"], ["partner"]),
  person("partner", ["in-law"]),
  person("in-law"),
  person("sibling", ["father", "mother"], ["sibling-partner"]),
  person("sibling-partner"),
  person("niece", ["sibling", "sibling-partner"]),
  person("grand-niece", ["niece"]),
  person("child", ["main", "partner"]),
  person("grandchild", ["child"]),
  person("outsider"),
];

test("generation limits preserve direct lines, partners and the archive, before layout projection", () => {
  const archive = { people },
    before = structuredClone(archive);
  const scope = generationScope(familyNeighbors(archive), limits);
  assert.deepEqual(
    [...scope].sort(),
    ["main", "father", "mother", "grand", "great", "partner", "child"].sort(),
  );
  const projection = projectTree(archive, scope);
  assert.equal(projection.people.length, 7);
  assert.deepEqual(
    projection.people.find((p) => p.id === "great")!.parents,
    [],
  );
  assert.deepEqual(projection.people.find((p) => p.id === "child")!.parents, [
    "main",
    "partner",
  ]);
  assert.deepEqual(archive, before);
});

test("collateral depth counts generations from a direct line and respects descendant limits", () => {
  const index = familyNeighbors({ people });
  const one = generationScope(index, { ...limits, collateral: 1 });
  for (const id of ["uncle", "sibling", "sibling-partner"])
    assert.ok(one.has(id), id);
  for (const id of ["cousin", "niece", "grand-niece"])
    assert.ok(!one.has(id), id);
  const two = generationScope(index, { ...limits, collateral: 2 });
  for (const id of ["cousin", "niece"]) assert.ok(two.has(id), id);
  for (const id of ["cousin-child", "grand-niece"]) assert.ok(!two.has(id), id);
  const deep = generationScope(index, {
    ...limits,
    ancestors: 7,
    descendants: 50,
    collateral: 2,
  });
  assert.ok(deep.has("oldest"));
  assert.ok(deep.has("grandchild"));
  assert.ok(!deep.has("in-law"));
  assert.ok(!deep.has("outsider"));
});

test("unilateral spouse records and exact co-parents stay visible without opening other unions", () => {
  const archive = {
    people: [
      person("main"),
      person("child", ["main", "co-parent"]),
      person("co-parent"),
      person("partner", [], ["main", "partner-of-partner"]),
      person("partner-of-partner"),
    ],
  };
  assert.deepEqual(
    [...generationScope(familyNeighbors(archive), limits)].sort(),
    ["main", "child", "co-parent", "partner"].sort(),
  );
});

test("1000-person genealogy is reduced to the chosen generations; stale anchors and cycles terminate", () => {
  const large = Array.from({ length: 1023 }, (_, i) =>
    person(String(i), i ? [String(Math.floor((i - 1) / 2))] : []),
  );
  const index = familyNeighbors({ people: large });
  const scope = generationScope(index, { ...limits, anchorId: "31" });
  assert.equal(scope.size, 6); // selected person, three ancestors, two children
  assert.equal(projectTree({ people: large }, scope).people.length, 6);
  assert.equal(generationScope(index, limits).size, large.length);
  const cyclic = familyNeighbors({
    people: [person("main", ["a"]), person("a", ["main"])],
  });
  assert.equal(
    generationScope(cyclic, { ...limits, ancestors: 7, descendants: 50 }).size,
    2,
  );
});
