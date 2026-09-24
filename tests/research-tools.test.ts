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
  photos: [
    {
      id: "family-photo",
      url: "/media/family-photo.jpg",
      title: "Семья у дома",
      year: "1975",
      place: "Нижнее",
      description: "Летняя встреча семьи",
      tags: [
        {
          id: "tag-child",
          personId: "child",
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.2,
        },
      ],
    },
  ],
};

test("research tools expose a stable read-only catalogue", () => {
  assert.ok(RESEARCH_TOOL_DEFINITIONS.length >= 11);
  assert.ok(
    RESEARCH_TOOL_DEFINITIONS.every(
      (tool) => tool.name && tool.description && tool.scope,
    ),
  );
  assert.equal(
    RESEARCH_TOOL_DEFINITIONS.find((tool) => tool.name === "get_relationship")
      ?.scope,
    "analysis:read",
  );
});

test("surname group includes birth surname and grammatical forms, and only direct parents", () => {
  const branch: Family = {
    ...family,
    people: [
      person("root", "Иван", "1900", { surname: "Чепчугов", sex: "m" }),
      person("other-parent", "Мария", "1901", { surname: "Вьюхина", sex: "f" }),
      person("daughter", "Анна", "1930", {
        surname: "Родина",
        maidenName: "Чепчугова",
        sex: "f",
        parents: ["root", "other-parent"],
      }),
      person("son", "Павел", "1932", {
        surname: "Чепчугов",
        parents: ["root", "other-parent"],
      }),
      person("grandson", "Дмитрий", "1960", {
        surname: "Родин",
        parents: ["daughter"],
      }),
      person("unrelated", "Василий", "1933", { surname: "Скулко" }),
    ],
  };
  const result = executeResearchTool(branch, "get_surname_group", {
    surname: "Чепчуговых",
  }) as {
    people: Array<{ id: string; birthSurname: string | null }>;
    personIds: string[];
    edges: Array<{ from: string; to: string; type: string }>;
    mermaid: string;
  };
  assert.deepEqual(
    result.people.map((item) => item.id),
    ["root", "daughter", "son"],
  );
  assert.equal(result.people[1].birthSurname, "Чепчугова");
  assert.deepEqual(
    new Set(result.personIds),
    new Set(["root", "daughter", "son", "other-parent"]),
  );
  assert.ok(
    result.edges.some(
      (edge) =>
        edge.from === "root" &&
        edge.to === "daughter" &&
        edge.type === "parent",
    ),
  );
  assert.match(result.mermaid, /^graph TD\n/);
  assert.doesNotMatch(result.mermaid, /Дмитрий|Василий/);
});

test("evidence tools distinguish card sources from unsourced events and awards", () => {
  const archive: Family = {
    ...family,
    people: [
      person("a", "Иван", "1900", {
        events: [{ id: "move", type: "move", date: "1920" }],
        awards: [{ id: "prize", name: "Медаль" }],
      }),
    ],
  };
  const gaps = executeResearchTool(archive, "find_evidence_gaps", {
    personId: "a",
  }) as { gaps: Array<{ kind: string }>; total: number };
  assert.deepEqual(
    gaps.gaps.map((gap) => gap.kind),
    ["card", "event", "award"],
  );
  assert.equal(gaps.total, 3);
  const coverage = executeResearchTool(archive, "get_evidence_coverage", {
    personId: "a",
  }) as { note: string; records: Array<{ cardSourceCount: number }> };
  assert.match(coverage.note, /не привязаны к отдельным полям/);
  assert.equal(coverage.records[0].cardSourceCount, 0);
});

test("research tools search people and traverse genealogy", () => {
  const listed = executeResearchTool(family, "list_people", {
    limit: 100,
  }) as { people: Array<{ id: string }>; total: number; hasMore: boolean };
  assert.equal(listed.total, 4);
  assert.equal(listed.hasMore, false);
  assert.deepEqual(
    new Set(listed.people.map((person) => person.id)),
    new Set(["father", "mother", "child", "grandchild"]),
  );

  const search = executeResearchTool(family, "search_people", {
    query: "Василий",
  }) as { people: Array<{ id: string }> };
  assert.deepEqual(
    search.people.map((person) => person.id),
    ["child"],
  );
  const reversedName = executeResearchTool(family, "search_people", {
    query: "Василий Скулко",
  }) as { people: Array<{ id: string }> };
  assert.deepEqual(
    reversedName.people.map((person) => person.id),
    ["child"],
  );
  const normalizedShortName = executeResearchTool(family, "search_people", {
    query: "у Васи Скулко",
  }) as { people: Array<{ id: string }> };
  assert.deepEqual(
    normalizedShortName.people.map((person) => person.id),
    ["child"],
  );

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

test("family lookup returns siblings without guessing whether incomplete parentage is full", () => {
  const sister = person("sister", "Татьяна", "1944", {
      surname: "Вьюхина",
      sex: "f",
      parents: ["father", "mother"],
    }),
    halfBrother = person("half-brother", "Пётр", "1950", {
      sex: "m",
      parents: ["father"],
    }),
    siblingFamily = {
      ...family,
      people: [...family.people, sister, halfBrother],
    },
    search = executeResearchTool(siblingFamily, "search_people", {
      query: "У Тани Вьюхиной есть братья?",
    }) as { people: Array<{ id: string }> },
    typoSearch = executeResearchTool(siblingFamily, "search_people", {
      query: "Татяна Вюхена",
    }) as { people: Array<{ id: string }> },
    result = executeResearchTool(siblingFamily, "get_family", {
      personId: "sister",
    }) as unknown as {
      siblings: Array<{
        person: { id: string };
        sharedParentIds: string[];
        kind: string;
      }>;
    };
  assert.deepEqual(
    search.people.map((person) => person.id),
    ["sister"],
  );
  assert.deepEqual(
    typoSearch.people.map((person) => person.id),
    ["sister"],
  );
  assert.deepEqual(
    result.siblings.map((item) => ({
      id: item.person.id,
      sharedParentIds: item.sharedParentIds,
      kind: item.kind,
    })),
    [
      {
        id: "child",
        sharedParentIds: ["father", "mother"],
        kind: "full",
      },
      {
        id: "half-brother",
        sharedParentIds: ["father"],
        kind: "half_or_unknown",
      },
    ],
  );
});

test("cousin lookup finds the requested degree and excludes siblings", () => {
  const grandfather = person("cousin-grandfather", "Иван", "1910", {
      sex: "m",
    }),
    grandmother = person("cousin-grandmother", "Мария", "1912", {
      sex: "f",
    }),
    firstParent = person("cousin-parent-a", "Анна", "1935", {
      sex: "f",
      parents: [grandfather.id, grandmother.id],
      parentageComplete: true,
    }),
    secondParent = person("cousin-parent-b", "Пётр", "1938", {
      sex: "m",
      parents: [grandfather.id, grandmother.id],
      parentageComplete: true,
    }),
    reference = person("cousin-reference", "Татьяна", "1960", {
      surname: "Вьюхина",
      sex: "f",
      parents: [firstParent.id],
    }),
    sibling = person("cousin-sibling", "Александра", "1962", {
      surname: "Вьюхина",
      sex: "f",
      parents: [firstParent.id],
    }),
    cousin = person("cousin-result", "Василий", "1964", {
      sex: "m",
      parents: [secondParent.id],
    }),
    cousinFamily: Family = {
      ...family,
      people: [
        grandfather,
        grandmother,
        firstParent,
        secondParent,
        reference,
        sibling,
        cousin,
      ],
    },
    result = executeResearchTool(cousinFamily, "get_cousins", {
      personId: reference.id,
      degree: 2,
    }) as {
      person: { id: string };
      degree: number;
      relatives: Array<{
        person: { id: string };
        term: string;
        commonAncestors: Array<{ id: string }>;
        path: Array<{ id: string }>;
      }>;
      total: number;
      hasMore: boolean;
    };

  assert.equal(result.person.id, reference.id);
  assert.equal(result.degree, 2);
  assert.equal(result.total, 1);
  assert.equal(result.hasMore, false);
  assert.equal(result.relatives[0].person.id, cousin.id);
  assert.equal(result.relatives[0].term, "двоюродный брат");
  assert.deepEqual(
    new Set(result.relatives[0].commonAncestors.map((item) => item.id)),
    new Set([grandfather.id, grandmother.id]),
  );
  assert.ok(
    result.relatives[0].path.some((item) => item.id === secondParent.id),
  );
  assert.ok(!result.relatives.some((item) => item.person.id === sibling.id));
});

test("archive insight generation count matches the tree summary", () => {
  const result = executeResearchTool(family, "get_archive_insights", {}) as {
    totals: { generations: number };
  };
  assert.equal(result.totals.generations, 3);
});

test("genealogy graph includes deterministic Mermaid with exact edge semantics", () => {
  const spouse = person("spouse", "Людмила", "1946", {
      spouses: ["child"],
    }),
    graphFamily: Family = {
      ...family,
      people: [
        father,
        mother,
        { ...child, spouses: ["spouse"] },
        spouse,
        grandchild,
      ],
    },
    result = executeResearchTool(graphFamily, "get_genealogy_graph", {
      personId: "child",
      direction: "both",
      depth: 2,
    }) as {
      mermaid: string;
    };
  assert.match(result.mermaid, /^graph TD/m);
  assert.match(result.mermaid, /n0 --> n2/);
  assert.match(result.mermaid, /n1 --> n2/);
  assert.match(result.mermaid, /n2 --- n3/);
  assert.match(result.mermaid, /n2 --> n4/);
});

test("relationship analysis matches the archive kinship calculation", () => {
  const result = executeResearchTool(family, "get_relationship", {
    firstPersonId: "father",
    secondPersonId: "grandchild",
  }) as {
    relation: { kind: string; title: string; roles?: Array<{ term: string }> };
    path: Array<{ id: string }>;
  };
  assert.equal(result.relation.kind, "direct");
  assert.match(result.relation.roles?.[0]?.term || "", /дед/);
  assert.deepEqual(
    result.path.map((person) => person.id),
    ["father", "child", "grandchild"],
  );
});

test("photo tools expose metadata and tagged people without file paths", () => {
  const search = executeResearchTool(family, "search_photos", {
    query: "Василий Нижнее",
  }) as { photos: Array<{ id: string; people: Array<{ id: string }> }> };
  assert.equal(search.photos[0]?.id, "family-photo");
  assert.deepEqual(
    search.photos[0]?.people.map((person) => person.id),
    ["child"],
  );

  const result = executeResearchTool(family, "get_photo", {
    photoId: "family-photo",
  }) as { photo: Record<string, unknown> };
  assert.equal(result.photo.title, "Семья у дома");
  assert.equal("url" in result.photo, false);

  const relatedPhotoFamily: Family = {
      ...family,
      people: [
        father,
        { ...mother, sex: "f" },
        { ...child, sex: "m" },
        grandchild,
      ],
      photos: [
        {
          ...family.photos![0],
          tags: [
            ...family.photos![0].tags,
            {
              id: "tag-mother",
              personId: "mother",
              x: 0.4,
              y: 0.1,
              width: 0.2,
              height: 0.2,
            },
          ],
        },
      ],
    },
    related = executeResearchTool(relatedPhotoFamily, "get_photo", {
      photoId: "family-photo",
    }) as {
      photo: {
        documentedRelationships: Array<{
          type: string;
          from: { id: string; role: string };
          to: { id: string; role: string };
        }>;
      };
    };
  assert.deepEqual(related.photo.documentedRelationships, [
    {
      type: "parent",
      from: {
        id: "mother",
        name: "Лебедь Анна",
        role: "мать",
      },
      to: {
        id: "child",
        name: "Скулко Василий Митрофанович",
        role: "сын",
      },
    },
  ]);
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
  assert.ok(
    result.items[0].reasons.includes(
      "сведения о родителях отмечены как неполные",
    ),
  );
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

test("probable duplicate search handles surname variants and incomplete dates", () => {
  const duplicateFamily: Family = {
    title: "Дубли",
    description: "",
    demo: false,
    people: [
      person("anna-a", "Анна", "1919", {
        surname: "Лебедь",
        patronymic: "Семёновна",
        sex: "f",
        birthPlace: "Нижнее",
      }),
      person("anna-b", "Anna", "", {
        surname: "Lebet",
        patronymic: "Semenovna",
        sex: "f",
        birthPlace: "с. Нижнее",
      }),
      person("anna-other", "Анна", "1950", {
        surname: "Лебедь",
        patronymic: "Семёновна",
        sex: "f",
        birthPlace: "Москва",
      }),
    ],
  };

  const result = executeResearchTool(
    duplicateFamily,
    "find_possible_duplicates",
    { limit: 10 },
  ) as {
    matches: Array<{
      score: number;
      confidence: string;
      people: Array<{ id: string }>;
      reasons: string[];
      conflicts: string[];
    }>;
    total: number;
  };

  assert.equal(result.total, 1);
  assert.deepEqual(
    result.matches[0].people.map((item) => item.id),
    ["anna-a", "anna-b"],
  );
  assert.equal(result.matches[0].confidence, "medium");
  assert.ok(
    result.matches[0].reasons.includes("фамилии отличаются одной буквой"),
  );
  assert.ok(
    result.matches[0].reasons.includes(
      "в одной из карточек год рождения неизвестен",
    ),
  );

  const focused = executeResearchTool(
    duplicateFamily,
    "find_possible_duplicates",
    { personId: "anna-a", limit: 10 },
  ) as { matches: Array<{ people: Array<{ id: string }> }> };
  assert.deepEqual(
    focused.matches.map((match) => match.people.map((item) => item.id)),
    [["anna-a", "anna-b"]],
  );
});
