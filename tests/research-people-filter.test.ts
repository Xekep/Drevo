import test from "node:test";
import assert from "node:assert/strict";
import {
  filterResearchPeople,
  queryResearchPeople,
} from "../src/domain/research-people-filter.ts";
import {
  executeResearchTool,
  RESEARCH_TOOL_DEFINITIONS,
} from "../src/domain/research-tools.ts";
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

test("criteria queries count the whole archive, paginate stably and share tree filter semantics", () => {
  const family = {
    people: Array.from({ length: 601 }, (_, index) =>
      person(`p-${index}`, {
        surname: "Иванова",
        name: "Анна",
        sex: "f",
        birth: "1940",
        birthPlace: "Москва",
      }),
    ),
  } as Family;
  const before = structuredClone(family);
  const criteria = {
    surname: "Ивановых",
    sex: "f",
    birthYearFrom: 1900,
    birthYearTo: 1950,
    anyOf: [{ birthPlaceContains: "москва" }, { birthPlaceContains: "Тула" }],
  };
  const count = executeResearchTool(family, "query_people", {
    criteria,
    limit: 0,
  }) as {
    total: number;
    countOnly: boolean;
    people: unknown[];
    hasMore: boolean;
    nextOffset: number | null;
  };
  assert.equal(count.total, 601);
  assert.equal(count.countOnly, true);
  assert.deepEqual(count.people, []);
  assert.equal(count.hasMore, false);
  assert.equal(count.nextOffset, null);
  const ids: string[] = [];
  for (let offset = 0; offset < 601; offset += 100) {
    const page = executeResearchTool(family, "query_people", {
      criteria,
      offset,
      limit: 100,
    }) as {
      total: number;
      people: Array<{ id: string }>;
      hasMore: boolean;
      nextOffset: number | null;
    };
    assert.equal(page.total, 601);
    assert.equal(page.hasMore, offset < 600);
    assert.equal(page.nextOffset, offset < 600 ? offset + 100 : null);
    ids.push(...page.people.map((p) => p.id));
  }
  assert.equal(new Set(ids).size, 601);
  assert.deepEqual(
    new Set(ids),
    new Set(filterResearchPeople(family, criteria, "include").personIds),
  );
  assert.deepEqual(family, before);
  assert.equal(
    RESEARCH_TOOL_DEFINITIONS.find((tool) => tool.name === "query_people")
      ?.scope,
    "tree:read",
  );
});

test("AND, OR and exclusion combine names, maiden names, places and recorded death", () => {
  const family = {
    people: [
      person("anna", {
        surname: "Петрова",
        maidenName: "Иванова",
        name: "Анна",
        sex: "f",
        birthPlace: "г. Москва",
        death: "1980",
        occupation: "Врач",
      }),
      person("boris", {
        surname: "Иванов",
        name: "Борис",
        sex: "m",
        birthPlace: "Тула",
        needsReview: true,
      }),
      person("olga", {
        surname: "Иванова",
        name: "Ольга",
        sex: "f",
        birthPlace: "Тула",
        deathPlace: "Орёл",
        occupation: "Врач",
      }),
      person("other", { surname: "Сидоров" }),
    ],
  } as Family;
  const criteria = {
    surname: "Ивановы",
    occupationContains: "врач",
    allOf: [{ sex: "f" }, { deceased: true }],
    anyOf: [{ birthPlaceContains: "москва" }, { birthPlaceContains: "тула" }],
    noneOf: [{ nameContains: "ОЛЬГА" }, { needsReview: true }],
  };
  assert.deepEqual(
    filterResearchPeople(family, criteria, "include").personIds,
    ["anna"],
  );
  assert.deepEqual(
    filterResearchPeople(family, criteria, "exclude").personIds,
    ["boris", "olga", "other"],
  );
  assert.deepEqual(
    filterResearchPeople(family, { deathPlaceContains: "орел" }, "include")
      .personIds,
    ["olga"],
  );
  assert.deepEqual(
    filterResearchPeople(
      family,
      { deathYearFrom: 1980, deathYearTo: 1980 },
      "include",
    ).personIds,
    ["anna"],
  );
});

test("missing data filters use valid dates, nested citations and accessible photo tags", () => {
  const family = {
    people: [
      person("fact", {
        birth: "1900",
        death: "1980-02",
        birthDateClaim: {
          value: "1900",
          sources: [{ title: "Запись", type: "archive", reference: "1" }],
        },
      }),
      person("award", {
        birth: "1900-02-31",
        awards: [{ id: "a", name: "Награда", source: { title: "Книга" } }],
      }),
      person("tagged", { birth: "", deceased: true }),
      person("portrait", { photo: "/portrait.jpg" }),
    ],
    photos: [
      {
        id: "photo",
        url: "/photo.jpg",
        title: "Фото",
        tags: [
          { id: "tag", personId: "tagged", x: 0, y: 0, width: 1, height: 1 },
        ],
      },
    ],
  } as Family;
  assert.deepEqual(
    filterResearchPeople(family, { hasSources: true }, "include").personIds,
    ["fact", "award"],
  );
  assert.deepEqual(
    filterResearchPeople(
      family,
      { hasBirthDate: false, hasDeathDate: false },
      "include",
    ).personIds,
    ["award", "tagged"],
  );
  assert.deepEqual(
    filterResearchPeople(
      family,
      { hasPhoto: true, hasSources: false },
      "include",
    ).personIds,
    ["tagged", "portrait"],
  );
});

test("event conditions must match the same event and never infer approximate dates", () => {
  const family = {
    people: [
      person("match", {
        events: [{ id: "e", type: "military", date: "1942", place: "Москва" }],
      }),
      person("split", {
        events: [
          { id: "m", type: "military", date: "1942", place: "Тула" },
          { id: "r", type: "residence", date: "1942", place: "Москва" },
        ],
      }),
      person("approximate", {
        events: [
          {
            id: "a",
            type: "military",
            dateText: "около 1942",
            place: "Москва",
          },
        ],
      }),
      person("yearsSplit", {
        events: [
          { id: "early", type: "military", date: "1930", place: "Москва" },
          { id: "late", type: "military", date: "1950", place: "Москва" },
        ],
      }),
    ],
  } as Family;
  assert.deepEqual(
    filterResearchPeople(
      family,
      {
        eventType: "military",
        eventPlaceContains: "Москва",
        eventYearFrom: 1941,
        eventYearTo: 1945,
      },
      "include",
    ).personIds,
    ["match"],
  );
  const grouped = {
    allOf: [
      { eventType: "military" },
      { eventPlaceContains: "Москва" },
      { eventYearFrom: 1941 },
      { eventYearTo: 1945 },
    ],
  };
  assert.deepEqual(filterResearchPeople(family, grouped, "include").personIds, [
    "match",
  ]);
  assert.deepEqual(
    filterResearchPeople(
      family,
      {
        eventType: "military",
        allOf: [
          { eventPlaceContains: "Москва" },
          { eventYearFrom: 1941 },
          { eventYearTo: 1945 },
        ],
      },
      "include",
    ).personIds,
    ["match"],
  );
  assert.equal(
    queryResearchPeople(family, { criteria: grouped, limit: 0 }).total,
    1,
  );
  assert.equal(
    queryResearchPeople(family, {
      criteria: grouped,
      mode: "exclude",
      limit: 0,
    }).total,
    3,
  );
  assert.deepEqual(
    filterResearchPeople(
      family,
      {
        eventType: "military",
        anyOf: [
          { eventPlaceContains: "Москва" },
          { eventPlaceContains: "Казань" },
        ],
      },
      "include",
    ).personIds,
    ["match", "approximate", "yearsSplit"],
  );
  assert.deepEqual(
    filterResearchPeople(
      family,
      { anyOf: [{ eventType: "military" }, { eventPlaceContains: "Москва" }] },
      "include",
    ).personIds,
    ["match", "split", "approximate", "yearsSplit"],
  );
  assert.deepEqual(
    filterResearchPeople(
      family,
      { eventType: "residence", noneOf: [{ eventType: "military" }] },
      "include",
    ).personIds,
    [],
  );
});

test("relation selection follows recorded edges only, includes half siblings and stays within the projection", () => {
  const people = [
    person("root"),
    person("parent", { parents: ["root"] }),
    person("anchor", { parents: ["parent", "hidden"] }),
    person("sibling", { parents: ["parent"] }),
    person("child", { parents: ["anchor"] }),
    person("grandchild", { parents: ["child"] }),
    person("spouse", { spouses: ["anchor"] }),
    person("adopted"),
  ];
  const family = {
    people,
    links: [
      {
        id: "adoption",
        from: "anchor",
        to: "adopted",
        type: "adoptive_parent",
      },
    ],
  } as Family;
  const select = (relation: string) =>
    filterResearchPeople(family, { relativeOf: "anchor", relation }, "include")
      .personIds;
  assert.deepEqual(select("ancestors"), ["root", "parent"]);
  assert.deepEqual(select("parents"), ["parent"]);
  assert.deepEqual(select("descendants"), ["child", "grandchild"]);
  assert.deepEqual(select("children"), ["child"]);
  assert.deepEqual(select("siblings"), ["sibling"]);
  assert.deepEqual(select("spouses"), ["spouse"]);
  assert.throws(
    () =>
      filterResearchPeople(
        family,
        { relativeOf: "hidden", relation: "children" },
        "include",
      ),
    /не найден/,
  );
  // Legacy malformed cycles must terminate and never select the anchor itself.
  const cycle = {
    people: [person("a", { parents: ["b"] }), person("b", { parents: ["a"] })],
  } as Family;
  assert.deepEqual(
    filterResearchPeople(
      cycle,
      { relativeOf: "a", relation: "ancestors" },
      "include",
    ).personIds,
    ["b"],
  );
});

test("criteria query rejects malformed groups, unknown fields, invalid ranges and pagination", () => {
  const family = { people: [person("one")] } as Family;
  for (const criteria of [
    { anyOf: [] },
    { noneOf: [{}] },
    { allOf: Array(11).fill({ sex: "m" }) },
    { anyOf: [{ anyOf: [{ sex: "m" }] }] },
    { anyOf: [{ typo: true }] },
    { nameContains: " " },
    { surname: "x".repeat(201) },
    { hasPhoto: "yes" },
    { eventType: "invented" },
    { eventYearFrom: 2000, eventYearTo: 1900 },
    { deathYearFrom: 2000, deathYearTo: 1900 },
    { relativeOf: "one" },
    { relation: "parents" },
  ])
    assert.throws(() =>
      executeResearchTool(family, "query_people", { criteria }),
    );
  for (const options of [
    { mode: "delete" },
    { limit: -1 },
    { limit: 101 },
    { offset: 0.5 },
    { limit: null },
    { typo: 1 },
  ])
    assert.throws(() =>
      executeResearchTool(family, "query_people", {
        criteria: { sex: "m" },
        ...options,
      }),
    );
});
