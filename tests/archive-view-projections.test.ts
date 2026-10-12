import test from "node:test";
import assert from "node:assert/strict";
import {
  galleryProjection,
  placesProjection,
  type GalleryPage,
} from "../src/domain/archive-view-projection.ts";
import { randomFamily } from "./layout-fixtures.ts";
import type { Family } from "../src/domain/types.ts";
import { archiveOverview } from "../src/domain/archive-projection.ts";
import { archiveDetails } from "../src/data/archive-details.ts";
import { archiveChanges } from "../src/domain/changes.ts";
import { analyzeFamilyInsights } from "../src/domain/family-insights.ts";
import { openArchive } from "../src/server/database.ts";

const family: Family = {
  title: "Тест",
  description: "",
  demo: false,
  people: randomFamily(1, 1).map((person) => ({
    ...person,
    name: person.id,
    surname: "Тест",
    patronymic: "",
    sex: "u",
    birthPlace: "Пермь",
    generation: 1,
    column: 1,
    biography: "x".repeat(10_000),
    sources: [{ type: "archive", title: "Источник", reference: "1" }],
    events: [
      {
        id: `event-${person.id}`,
        type: "residence",
        date: "1950",
        place: "Пермь",
        title: "Проживание",
      },
    ],
  })),
  photos: Array.from({ length: 73 }, (_, index) => ({
    id: `photo-${index}`,
    title: `Фото ${index}`,
    url: `/media/${index}.jpg`,
    year: index < 40 ? "1950" : "1960",
    tags:
      index === 72
        ? []
        : [
            {
              id: `tag-${index}`,
              personId: "f-0",
              x: 0,
              y: 0,
              width: 1,
              height: 1,
            },
          ],
  })),
};
test("SQL gallery index matches complete snapshot albums without full hydration", async () => {
  const archive = await openArchive(":memory:", family);
  try {
    const stored = (await archive.read()).family;
    archive.read = async () => {
      throw new Error("Full hydration forbidden");
    };
    for (const query of [
      { mode: "all" as const },
      { mode: "all" as const, offset: 30 },
      { mode: "people" as const },
      { mode: "years" as const },
      { mode: "years" as const, year: "1950", personId: "f-0" },
      { mode: "all" as const, personId: "unknown" },
    ])
      assert.deepEqual(
        await archive.gallery(query),
        galleryProjection(stored, query),
      );
    const events = await archive.viewPeople("places");
    assert.deepEqual(
      events.map((person) => person.events),
      stored.people.map((person) => person.events),
    );
    assert.ok(
      events.every(
        (person) =>
          !person.biography && !person.awards && !person.sources.length,
      ),
    );
  } finally {
    await archive.close();
  }
});
test("gallery pages retain canonical order, bounded objects, album counts and unknown albums", () => {
  const first = galleryProjection(family, { mode: "all" });
  const second = galleryProjection(family, { mode: "all", offset: 30 });
  const last = galleryProjection(family, { mode: "all", offset: 60 });
  assert.equal(first.photos.length, 30);
  assert.equal(first.total, 73);
  assert.deepEqual(
    [...first.photos, ...second.photos, ...last.photos].map(
      (photo) => photo.id,
    ),
    first.photoIds,
  );
  assert.equal(new Set(first.photoIds).size, 73);
  assert.deepEqual(
    galleryProjection(family, { mode: "people" }).albums.map((album) => [
      album.id,
      album.count,
    ]),
    [
      ["f-0", 72],
      ["unknown", 1],
    ],
  );
  assert.equal(
    galleryProjection(family, { mode: "all", personId: "unknown" }).photos[0]
      .id,
    "photo-72",
  );
  assert.equal(
    galleryProjection(family, { mode: "years", year: "1950", personId: "f-0" })
      .total,
    40,
  );
  assert.equal(
    galleryProjection(family, { mode: "years", year: "1800" }).total,
    0,
  );
  assert.equal(
    galleryProjection(family, { mode: "all", personId: "hidden" }).total,
    0,
  );
  assert.equal(
    galleryProjection(family, { mode: "all", offset: 1000 }).photos.length,
    0,
  );
});
test("map hydration preserves loaded biographies/citations; coordinate editing changes only the event", async () => {
  const overview = archiveOverview(family),
    token = "1:fixture";
  let latest = {
    family: overview,
    revision: 1,
    pageToken: token,
    partial: true,
    totals: { people: family.people.length, photos: 73 },
  };
  overview.people[0] = structuredClone(family.people[0]);
  const original = structuredClone(overview.people[0]);
  const reader = archiveDetails(
    latest,
    async (url) => {
      assert.equal(
        new URL(url, "http://local.test").searchParams.get("projection"),
        "places",
      );
      return Response.json({ ...placesProjection(family), pageToken: token });
    },
    (header) => {
      latest = header;
    },
  );
  await reader.loadView("places");
  await reader.loadView("places");
  assert.deepEqual(latest.family.people[0], original);
  assert.equal(reader.hasPerson(family.people[1].id), false);
  assert.equal(reader.isComplete("photos"), true);
  assert.equal(reader.isComplete("people"), false);
  const next = structuredClone(latest.family);
  next.people[1].events![0].location = { place: "Пермь", lat: 58, lon: 56 };
  const changes = archiveChanges(latest.family, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "events");
  reader.replace(next, 2);
  assert.equal(reader.hasView("places"), false);
});
test("aggregate insights do not require client-side biography/source hydration and invalidate after writes", async () => {
  let count = 0;
  const initial = {
    family: archiveOverview(family),
    revision: 1,
    pageToken: "1:fixture",
    partial: true,
  };
  const reader = archiveDetails(
    initial,
    async (url) => {
      count++;
      return Response.json({
        insights: analyzeFamilyInsights(family),
        pageToken: new URL(url, "http://local.test").searchParams.get("token"),
      });
    },
    () => {},
  );
  await reader.loadView("insights");
  await reader.loadView("insights");
  assert.equal(count, 1);
  assert.equal(reader.insights()!.totals.photos, 73);
  assert.equal(reader.isComplete("people"), false);
  reader.replace(initial.family, 2);
  assert.equal(reader.insights(), undefined);
  assert.equal(reader.hasView("insights"), false);
});
test("a short or duplicate gallery page is rejected rather than looping automatic pagination", async () => {
  const initial = {
    family: archiveOverview(family),
    revision: 1,
    pageToken: "1:fixture",
    partial: true,
  };
  let data: GalleryPage = { albums: [], photos: [], photoIds: ["a"], total: 1 };
  const reader = archiveDetails(
    initial,
    async () => Response.json({ ...data, pageToken: initial.pageToken }),
    () => {},
  );
  await assert.rejects(reader.gallery({ mode: "all" }), /Неполная страница/);
  data = {
    albums: [],
    photos: [family.photos![0], family.photos![0]],
    photoIds: [family.photos![0].id, family.photos![0].id],
    total: 2,
  };
  await assert.rejects(reader.gallery({ mode: "all" }), /Неполная страница/);
});

test("gallery SQL compact index is shared by concurrent reads and later pages, but not dirty transactions", async () => {
  const archive = await openArchive(":memory:", family);
  const prepare = archive.db.prepare.bind(archive.db);
  let compactReads = 0;
  archive.db.prepare = (sqlite, postgres) => {
    if (sqlite.startsWith("SELECT json_object(") && sqlite.includes(" AS data FROM photos")) compactReads++;
    return prepare(sqlite, postgres);
  };
  try {
    const [first, second] = await Promise.all([archive.gallery({ mode: "all" }), archive.gallery({ mode: "all", offset: 30, includeIndex: false })]);
    assert.equal(compactReads, 1, "cold requests coalesce their revision/scope index");
    assert.equal(first.photoIds!.length, 73);
    assert.equal("photoIds" in second, false, "later pages need not resend the archive-wide ids");
    await archive.gallery({ mode: "all", offset: 60, includeIndex: false });
    assert.equal(compactReads, 1);
    await archive.db.transaction(async () => {
      await archive.gallery({ mode: "all" });
      assert.equal(compactReads, 2, "arbitrary write transactions must not reuse or populate committed caches");
    });
    await archive.gallery({ mode: "all" });
    assert.equal(compactReads, 2);
    await archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
    await archive.gallery({ mode: "all" });
    assert.equal(compactReads, 3, "archive revision changes invalidate the compact index");
  } finally { await archive.close(); }
});

test("gallery transport sends a full order index once per query and revision", async () => {
  const initial = { family: archiveOverview(family), revision: 1, pageToken: "1:test", partial: true };
  const calls: URL[] = [];
  const reader = archiveDetails(initial, async input => {
    const url = new URL(input, "https://example.test");
    calls.push(url);
    const page = galleryProjection(family, { mode: "all", offset: Number(url.searchParams.get("offset")), includeIndex: url.searchParams.get("index") !== "0" });
    return Response.json({ ...page, pageToken: url.searchParams.get("token") });
  }, () => {});
  const first = await reader.gallery({ mode: "all" });
  const second = await reader.gallery({ mode: "all", offset: 30 });
  assert.equal(calls[0].searchParams.has("index"), false);
  assert.equal(calls[1].searchParams.get("index"), "0");
  assert.deepEqual(second.photoIds, first.photoIds);
  reader.replace(initial.family, 2);
  await reader.gallery({ mode: "all" });
  assert.equal(calls[2].searchParams.has("index"), false);
});

test("timeline projection preserves complete events/awards but does not hydrate biographies, sources or photos", async () => {
  const archive = await openArchive(":memory:", family);
  try {
    const stored = (await archive.read()).family;
    archive.read = async () => { throw new Error("full archive forbidden"); };
    const people = await archive.viewPeople("timeline");
    assert.deepEqual(people.map(person => person.events), stored.people.map(person => person.events));
    assert.ok(people.every(person => !person.biography && person.sources.length === 0));
    const initial = { family: archiveOverview(stored), revision: 1, pageToken: "1:timeline", partial: true };
    let latest = initial;
    const reader = archiveDetails(initial, async () => Response.json({ people: people.map(({ id, events, awards }) => ({ id, ...(events ? { events } : {}), ...(awards ? { awards } : {}) })), pageToken: initial.pageToken }), header => { latest = header; });
    await reader.loadView("timeline");
    assert.deepEqual(latest.family.people.map(person => person.events), stored.people.map(person => person.events));
    assert.equal(reader.isComplete("people"), false);
    assert.equal(reader.hasPerson(stored.people[0].id), false);
    assert.equal(latest.family.photos!.length, 0);
  } finally { await archive.close(); }
});
