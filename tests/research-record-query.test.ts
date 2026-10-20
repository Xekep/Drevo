import test from "node:test";
import assert from "node:assert/strict";
import type { Family, Person, Source } from "../src/domain/types.ts";
import { executeResearchTool } from "../src/domain/research-tools.ts";
import { queryResearchPeople } from "../src/domain/research-people-filter.ts";
import {
  getResearchEvent,
  queryResearchEvents,
} from "../src/domain/research-event-query.ts";
import { queryResearchPlaces } from "../src/domain/research-place-query.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import { researchEvidenceAnchor } from "../src/domain/research-evidence.ts";
import { collectPersonSources } from "../src/domain/person-sources.ts";
import { collectEventEvidenceReferences } from "../src/server/ai-research-support.ts";
import type { ResearchAnswerReference } from "../src/domain/research-answer.ts";

const source: Source = {
  type: "Архив",
  title: "Метрическая книга",
  reference: "Ф.6, Оп.13, Д.104",
  url: "https://example.org/archive",
};
const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  name: id,
  surname: "Тест",
  patronymic: "",
  birth: "",
  birthPlace: "",
  sex: "u",
  parents: [],
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
  ...extra,
});
const family: Family = {
  title: "Тест",
  description: "",
  demo: false,
  people: [
    person("one", {
      events: [
        {
          id: "marriage",
          type: "marriage",
          date: "1910",
          place: "Екатеринбург",
          sources: [source],
          location: { place: "Екатеринбург", lat: 56.8, lon: 60.6 },
        },
      ],
    }),
    person("mixed", {
      sources: [source],
      events: [
        { id: "a", type: "marriage", date: "1910", place: "Москва" },
        {
          id: "b",
          type: "residence",
          date: "1910",
          place: "Екатеринбург",
          sources: [source],
        },
      ],
    }),
    person("mixed-sources", {
      events: [
        {
          id: "a",
          type: "marriage",
          date: "1911",
          place: "Екатеринбург",
          sources: [
            { ...source, title: "Другой источник" },
            { ...source, type: "Книга" },
          ],
        },
      ],
    }),
    person("partner-a"),
    person("partner-b"),
  ],
  unions: [
    {
      id: "union",
      type: "marriage",
      participants: ["partner-a", "partner-b"],
      formation: { date: "1918", place: "Екатеринбург", sources: [source] },
    },
  ],
};
const criteria = {
  type: "marriage",
  placeContains: "Екатеринбург",
  yearFrom: 1900,
  yearTo: 1920,
  sourceType: "Архив",
  sourceTitleContains: "Метрическая",
};

test("event queries count shared unions once and require all criteria on one event and one source", () => {
  const result = queryResearchEvents(family, { criteria, limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].date, "1910");
  const next = queryResearchEvents(family, { criteria, offset: 1 });
  assert.equal(next.events[0].people.length, 2);
  assert.equal(next.events[0].date, "1918");
  assert.equal(
    queryResearchEvents(family, { criteria, limit: 0 }).events.length,
    0,
  );
  assert.equal(queryResearchEvents(family, { criteria, limit: 0 }).total, 2);
  assert.equal(
    getResearchEvent(family, { eventId: result.events[0].id }).evidence
      .sources[0].scope,
    "event",
  );
  assert.deepEqual(
    executeResearchTool(family, "query_events", { criteria }),
    queryResearchEvents(family, { criteria }),
  );
});
test("people queries join the place and source through the same actual event, including shared marriage records", () => {
  const result = queryResearchPeople(family, {
    criteria: {
      eventType: "marriage",
      eventPlaceContains: "Екатеринбург",
      eventYearFrom: 1900,
      eventYearTo: 1920,
      eventSourceType: "Архив",
      eventSourceTitleContains: "Метрическая",
    },
  });
  assert.deepEqual(
    result.people.map((p) => p.id),
    ["one", "partner-a", "partner-b"],
  );
  assert.ok(result.people.every((p) => p.evidence?.length));
  assert.equal(
    result.people.find((p) => p.id === "one")!.evidence![0].sourceCount,
    1,
  );
});
test("source conditions across groups still require a single source on a single event", () => {
  const result = queryResearchPeople(family, {
    criteria: {
      eventType: "marriage",
      eventPlaceContains: "Екатеринбург",
      allOf: [
        { eventSourceType: "Архив" },
        { eventSourceTitleContains: "Метрическая" },
      ],
    },
  });
  assert.deepEqual(
    result.people.map((p) => p.id),
    ["one", "partner-a", "partner-b"],
  );
});

test("place queries filter event occurrences before grouping and preserve recorded coordinates and bounded evidence", () => {
  const result = queryResearchPlaces(family, {
    criteria: {
      nameContains: "екатеринбург",
      event: criteria,
      hasCoordinates: true,
    },
  });
  assert.equal(result.total, 1);
  assert.equal(result.places[0].eventCount, 2);
  assert.equal(result.places[0].peopleCount, 3);
  assert.deepEqual(
    result.places[0].locations.map((p) => [p.lat, p.lon]),
    [[56.8, 60.6]],
  );
  assert.equal(
    result.places[0].evidence.length,
    1,
    "counts cover all events while the place page embeds only a bounded example",
  );
  assert.equal(
    queryResearchPlaces(family, {
      criteria: { event: { type: "marriage", yearFrom: 2000 } },
      limit: 0,
    }).total,
    0,
  );
});
test("unknown or approximate dates, general person sources and stale claim sources never become evidence for the requested event", () => {
  const p = person("x", {
    birth: "1880",
    sources: [source],
    events: [
      {
        id: "a",
        type: "marriage",
        dateText: "около 1910 года",
        place: "Екатеринбург",
        sources: [source],
      },
      {
        id: "b",
        type: "marriage",
        date: "1910",
        place: "Екатеринбург",
        dateClaim: { value: "1911", sources: [source] },
      },
    ],
  });
  const data = { ...family, people: [p], unions: [] };
  assert.equal(queryResearchEvents(data, { criteria }).total, 0);
  assert.equal(
    queryResearchEvents(data, { criteria: { type: "birth", hasSources: true } })
      .total,
    0,
  );
});
test("only the supplied access projection is searchable; hidden union participants and their sources cannot be retrieved by ID", () => {
  const visible = projectFamilyForUser(family, {
    id: "reader",
    name: "Читатель",
    role: "reader",
    createdAt: "2026-10-21",
    approved: true,
    personId: "one",
    treeAccess: "common_ancestors",
  });
  assert.equal(queryResearchEvents(visible, { criteria }).total, 1);
  const hidden = queryResearchEvents(family, { criteria, offset: 1 }).events[0]
    .id;
  assert.throws(
    () => getResearchEvent(visible, { eventId: hidden }),
    /не найдено/,
  );
  assert.throws(
    () => queryResearchEvents(visible, { criteria: { personId: "partner-a" } }),
    /недоступен/,
  );
});
test("malformed filters cannot broaden queries and source access also gates derived filters and proof contents", () => {
  for (const raw of [
    { criteria: { sql: "SELECT *" } },
    { criteria: { yearFrom: 1920, yearTo: 1900 } },
    { criteria: { type: "invented" } },
    { limit: 101 },
    { offset: -1 },
    { criteria: { yearFrom: "1900" } },
  ])
    assert.throws(() => queryResearchEvents(family, raw));
  assert.throws(
    () => queryResearchEvents(family, { criteria }, false),
    /доступ/,
  );
  assert.throws(
    () =>
      queryResearchPeople(
        family,
        { criteria: { eventSourceType: "Архив" } },
        false,
      ),
    /доступ/,
  );
  assert.equal(
    queryResearchEvents(family, { criteria: { type: "marriage" } }, false)
      .events[0].evidence.sources.length,
    0,
  );
  assert.throws(() =>
    queryResearchPlaces(family, { criteria: { unknown: true } }),
  );
});
test("proof links use the same locator as merged source cards and only accessible records enter answer references", () => {
  const event = queryResearchEvents(family, { criteria }).events[0];
  const reference = event.evidence.sources[0];
  const summary = collectPersonSources(family.people[0])[0];
  assert.ok(reference.href.endsWith(researchEvidenceAnchor("source", summary)));
  const refs = new Map<
    string,
    Extract<ResearchAnswerReference, { kind: "source" }>
  >();
  collectEventEvidenceReferences(
    { events: [event] },
    new Map([["one", "Тест one"]]),
    refs,
  );
  assert.equal(refs.size, 2);
  assert.ok(
    [...refs.values()].every((r) => r.url?.startsWith("/people/one#drevo-")),
  );
  const hidden = new Map<
    string,
    Extract<ResearchAnswerReference, { kind: "source" }>
  >();
  collectEventEvidenceReferences({ events: [event] }, new Map(), hidden);
  assert.equal(hidden.size, 0);
});

test("large evidence pages keep exact totals and resumable offsets without dropping or repeating events", () => {
  const longSource = {
    ...source,
    title: "Книга".repeat(200),
    reference: "Дело".repeat(400),
    note: "Заметка".repeat(1000),
  };
  const data = {
    ...family,
    unions: [],
    people: [
      person("many", {
        events: Array.from({ length: 100 }, (_, i) => ({
          id: `event-${i}`,
          type: "marriage" as const,
          date: "1910",
          place: "Екатеринбург",
          sources: [
            longSource,
            { ...longSource, type: "Книга" },
            { ...longSource, reference: "иная" },
          ],
        })),
      }),
    ],
  };
  const seen = new Set<string>();
  let offset = 0;
  let pages = 0;
  for (;;) {
    const result = queryResearchEvents(data, {
      criteria: { type: "marriage" },
      offset,
      limit: 100,
    });
    assert.equal(result.total, 100);
    assert.ok(result.events.length > 0);
    for (const event of result.events) {
      assert.equal(seen.has(event.id), false);
      seen.add(event.id);
      assert.equal(event.evidence.sources[0].truncated, true);
      assert.ok(event.evidence.sources[0].title.length <= 201);
      assert.ok(event.evidence.sources[0].reference.length <= 601);
    }
    pages++;
    if (!result.hasMore) break;
    assert.equal(result.responseLimited, true);
    assert.equal(result.nextOffset, offset + result.events.length);
    offset = result.nextOffset!;
    assert.ok(pages < 100);
  }
  assert.ok(pages > 1);
  assert.equal(seen.size, 100);
  const counts = queryResearchEvents(data, { limit: 0 });
  assert.equal(counts.total, 100);
  assert.equal(counts.hasMore, false);
  assert.equal(counts.nextOffset, null);
});

test("evidence includes only sources satisfying the related filter and retains their actual attachment scope", () => {
  const data = {
    ...family,
    unions: [],
    people: [
      person("one", {
        events: [
          {
            id: "one",
            type: "marriage",
            date: "1910",
            sources: [{ ...source, type: "Книга" }, source],
            dateClaim: {
              value: "1910",
              sources: [{ ...source, title: "Дата", type: "Документ" }],
            },
          },
        ],
      }),
    ],
  };
  const result = queryResearchEvents(data, {
    criteria: { sourceType: "Архив" },
  });
  assert.equal(result.events[0].evidence.sourceCount, 3);
  assert.equal(result.events[0].evidence.matchingSourceCount, 1);
  assert.deepEqual(
    result.events[0].evidence.sources.map((s) => [s.type, s.scope]),
    [["Архив", "event"]],
  );
  const dates = queryResearchEvents(data, {
    criteria: { sourceType: "Документ" },
  });
  assert.equal(dates.events[0].evidence.sources[0].scope, "date");
});
