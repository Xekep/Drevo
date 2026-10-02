import test from "node:test";
import assert from "node:assert/strict";
import { filterResearchPeople } from "../src/domain/research-people-filter.ts";
import type { Family, Person } from "../src/domain/types.ts";

function person(id: string, overrides: Partial<Person> = {}): Person {
  return {
    id,
    surname: "Тест",
    name: id,
    patronymic: "",
    sex: "u",
    birth: "2000-06-15",
    birthPlace: "",
    parents: [],
    spouses: [],
    generation: 1,
    column: 0,
    sources: [],
    ...overrides,
  };
}

test("exclude deaths before 18 keeps adults, living children and unknown or borderline dates across the whole tree", () => {
  const people = [
    person("infant", { death: "2000-06-15" }),
    person("before18", { death: "2018-06-14" }),
    person("on18", { death: "2018-06-15" }),
    person("adult", { death: "2080" }),
    person("living"),
    person("missingBirth", { birth: "", death: "2017" }),
    person("missingDeath", { deceased: true }),
    person("yearChild", { birth: "2000", death: "2017" }),
    person("yearBoundary", { birth: "2000", death: "2018" }),
    person("invalid", { death: "1999-01-01" }),
    ...Array.from({ length: 600 }, (_, index) => person(`other-${index}`)),
  ];
  const family = { people } as Family;
  const result = filterResearchPeople(
    family,
    { deathAgeBefore: 18 },
    "exclude",
  );
  assert.equal(result.totalPeople, 610);
  assert.equal(result.matchedCount, 3);
  assert.equal(result.personIds.length, 607);
  assert.deepEqual(
    people.filter((p) => !result.personIds.includes(p.id)).map((p) => p.id),
    ["infant", "before18", "yearChild"],
  );
  assert.deepEqual(
    filterResearchPeople(family, { deathAgeBefore: 18 }, "include").personIds,
    ["infant", "before18", "yearChild"],
  );
});

test("combined criteria and zero matches operate only on the supplied visible archive", () => {
  const family = {
    people: [
      person("woman", { sex: "f", needsReview: true, death: "2080" }),
      person("man", { sex: "m", birth: "1950" }),
      person("unknown", { birth: "" }),
    ],
  } as Family;
  assert.deepEqual(
    filterResearchPeople(
      family,
      {
        sex: "f",
        deceased: true,
        needsReview: true,
        birthYearFrom: 1990,
        birthYearTo: 2000,
        deathAgeFrom: 18,
      },
      "include",
    ).personIds,
    ["woman"],
  );
  assert.deepEqual(
    filterResearchPeople(family, { birthYearTo: 1900 }, "include").personIds,
    [],
  );
  assert.deepEqual(
    filterResearchPeople(
      { people: [family.people[1]] } as Family,
      { needsReview: true },
      "exclude",
    ).personIds,
    ["man"],
  );
});

test("malformed filters cannot broaden the selection silently", () => {
  const family = { people: [person("one")] } as Family;
  for (const criteria of [
    null,
    [],
    {},
    { typo: 18 },
    { deathAgeBefore: "18" },
    { deathAgeBefore: 0 },
    { deathAgeBefore: 152 },
    { deceased: 1 },
    { sex: {} },
    { birthYearFrom: 2000, birthYearTo: 1900 },
    { deathAgeFrom: 18, deathAgeBefore: 18 },
  ])
    assert.throws(() => filterResearchPeople(family, criteria, "exclude"));
  assert.throws(() =>
    filterResearchPeople(family, { needsReview: true }, "delete"),
  );
});
