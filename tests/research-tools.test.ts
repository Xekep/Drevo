import test from "node:test";
import assert from "node:assert/strict";
import {
  executeResearchTool,
  RESEARCH_TOOL_DEFINITIONS,
} from "../src/domain/research-tools.ts";
import type { Family, Person } from "../src/domain/types.ts";

function person(
  id: string,
  name: string,
  birth: string,
  extra: Partial<Person> = {},
): Person {
  return {
    id,
    surname: "Скулко",
    name,
    patronymic: "",
    sex: "u",
    birth,
    birthPlace: "",
    parents: [],
    spouses: [],
    generation: 0,
    column: 0,
    sources: [],
    ...extra,
  };
}

const father = person("father", "Митрофан", "1910", {
    birthPlace: "Ворошиловградская область",
  }),
  mother = person("mother", "Анна", "1919", {
    surname: "Лебедь",
    sources: [
      { title: "Метрическая запись", type: "archive", reference: "Ф. 1" },
    ],
  }),
  child = person("child", "Василий", "1940-05-22", {
    patronymic: "Митрофанович",
    parents: ["father", "mother"],
    parentageComplete: true,
  }),
  grandchild = person("grandchild", "Евгений", "1970", {
    parents: ["child"],
  });

const family: Family = {
  title: "Архив",
  description: "",
  demo: false,
  people: [father, mother, child, grandchild],
};

test("research tools expose a stable read-only catalogue", () => {
  assert.ok(RESEARCH_TOOL_DEFINITIONS.length >= 11);
  assert.ok(
    RESEARCH_TOOL_DEFINITIONS.every(
      (tool) => tool.name && tool.description && tool.scope,
    ),
  );
});

test("research tools search people and traverse genealogy", () => {
  const search = executeResearchTool(family, "search_people", {
    query: "Василий",
  }) as { people: Array<{ id: string }> };
  assert.deepEqual(search.people.map((person) => person.id), ["child"]);

  const ancestors = executeResearchTool(family, "get_ancestors", {
    personId: "grandchild",
    depth: 2,
  }) as unknown as { people: Array<{ depth: number; person: { id: string } }> };
  assert.deepEqual(
    ancestors.people.map((item) => [item.depth, item.person.id]),
    [
      [1, "child"],
      [2, "father"],
      [2, "mother"],
    ],
  );

  const descendants = executeResearchTool(family, "get_descendants", {
    personId: "father",
    depth: 2,
  }) as unknown as { people: Array<{ person: { id: string } }> };
  assert.deepEqual(
    descendants.people.map((item) => item.person.id),
    ["child", "grandchild"],
  );
});

test("tree tools do not leak source scope and source tool stays explicit", () => {
  const card = executeResearchTool(family, "get_person", {
    personId: "mother",
  }) as { person: Record<string, unknown> };
  assert.equal("sources" in card.person, false);

  const sources = executeResearchTool(family, "get_sources", {
    personId: "mother",
  }) as { card: unknown[] };
  assert.equal(sources.card.length, 1);

  const missing = executeResearchTool(family, "find_missing_data", {
    personId: "grandchild",
  }) as { people: Array<{ missing: string[] }> };
  assert.ok(missing.people[0].missing.includes("источники"));
  assert.ok(missing.people[0].missing.includes("место рождения"));
});


test("branch insights summarize only the selected ancestry depth", () => {
  const result = executeResearchTool(family, "get_branch_insights", {
    personId: "grandchild",
    direction: "ancestors",
    depth: 2,
  }) as {
    anchor: { id: string };
    direction: string;
    depth: number;
    totals: {
      people: number;
      knownBirthDates: number;
      knownBirthPlaces: number;
      withSources: number;
      completeParentage: number;
    };
    missing: Array<{ id: string; missing: string[] }>;
  };

  assert.equal(result.anchor.id, "grandchild");
  assert.equal(result.direction, "ancestors");
  assert.equal(result.depth, 2);
  assert.equal(result.totals.people, 4);
  assert.equal(result.totals.knownBirthDates, 4);
  assert.equal(result.totals.withSources, 1);
  assert.ok(result.missing.some((item) => item.id === "grandchild"));
});


test("research backlog ranks high-yield documents inside the selected branch", () => {
  const result = executeResearchTool(family, "get_research_backlog", {
    personId: "grandchild",
    direction: "ancestors",
    depth: 2,
    limit: 8,
  }) as {
    anchor: { id: string };
    items: Array<{
      priority: number;
      documentType: string;
      person: { id: string };
      branchDepth: number;
      reasons: string[];
      expectedFields: string[];
      clues: string[];
    }>;
  };

  assert.equal(result.anchor.id, "grandchild");
  assert.ok(result.items.length > 0);
  assert.equal(result.items[0].person.id, "grandchild");
  assert.equal(result.items[0].documentType, "birth_or_baptism");
  assert.ok(result.items[0].priority >= result.items[1].priority);
  assert.ok(result.items[0].reasons.includes("сведения о родителях отмечены как неполные"));
  assert.ok(result.items[0].expectedFields.includes("родители"));
  assert.ok(
    result.items.every((item) =>
      ["grandchild", "child", "father", "mother"].includes(item.person.id),
    ),
  );
  assert.ok(
    result.items.some(
      (item) =>
        item.person.id === "father" &&
        item.documentType === "household_or_census" &&
        item.clues.some((clue) => clue.includes("Ворошиловградская область")),
    ),
  );
});
