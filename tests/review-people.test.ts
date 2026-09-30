import test from "node:test";
import assert from "node:assert/strict";
import { projectTree, withoutReviewPeople } from "../src/domain/family-neighborhood.ts";
import { executeResearchTool } from "../src/domain/research-tools.ts";
import type { Family, Person } from "../src/domain/types.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { unionGeometry } from "../src/domain/union-layout.ts";

const person = (index: number): Person => ({
  id: `person-${index}`,
  surname: "Иванов",
  name: `Имя ${index}`,
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  parents: index === 1 ? ["person-0"] : [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
  needsReview: index % 3 === 0,
});

test("review marker validates and a 1000-person temporary filter drops marked cards and their edges", () => {
  const family: Family = {
    title: "Архив",
    description: "",
    demo: false,
    people: Array.from({ length: 1000 }, (_, index) => person(index)),
    photos: [],
    links: [],
  };
  assert.doesNotThrow(() => validateFamily(family));
  const visible = new Set(family.people.map((item) => item.id));
  const filtered = withoutReviewPeople(family.people, visible);
  assert.equal(filtered.size, 666);
  assert.equal(filtered.has("person-0"), false);
  assert.equal(filtered.has("person-1"), true);
  const projected = projectTree(family, filtered);
  assert.equal(projected.people.length, 666);
  assert.deepEqual(projected.people.find((item) => item.id === "person-1")?.parents, []);
  assert.equal(family.people[0].needsReview, true);
  assert.equal(family.people[1].parents[0], "person-0");

  const invalid = structuredClone(family);
  (invalid.people[1] as unknown as { needsReview: unknown }).needsReview = "yes";
  assert.throws(() => validateFamily(invalid), /признак проверки/);
});

test("assistant review list counts all marked cards and paginates", () => {
  const family: Family = {
    title: "Архив",
    description: "",
    demo: false,
    people: Array.from({ length: 1000 }, (_, index) => person(index)),
    photos: [],
    links: [],
  };
  const result = executeResearchTool(family, "list_review_people", {
    offset: 100,
    limit: 20,
  }) as { total: number; people: { id: string }[]; hasMore: boolean };
  assert.equal(result.total, 334);
  assert.equal(result.people.length, 20);
  assert.equal(result.people[0].id, "person-300");
  assert.equal(result.hasMore, true);
});

test("all marked cards can produce an empty layout without calling ELK", async () => {
  const geometry = await unionGeometry([], async () => {
    throw new Error("ELK should not run for an empty projection");
  });
  assert.deepEqual(geometry.positions, []);
});
