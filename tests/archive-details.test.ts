import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveDetails,
  ArchiveDetailsAccessError,
} from "../src/data/archive-details.ts";
import {
  archiveOverview,
  personDetails,
} from "../src/domain/archive-projection.ts";
import { archiveChanges, applyArchiveChanges } from "../src/domain/changes.ts";
import type { ArchivePageHeader } from "../src/data/archive-pages.ts";
import type { Family } from "../src/domain/types.ts";

function fixture(count = 170) {
  const family: Family = {
    title: "Тестовый архив",
    description: "",
    demo: false,
    people: Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      name: `Имя ${i}`,
      surname: "Тест",
      patronymic: "",
      sex: "u",
      birth: "1900",
      birthPlace: "",
      parents: [],
      spouses: [],
      generation: 1,
      column: i,
      biography: `Биография ${i}:` + "x".repeat(1000),
      sources: [{ type: "archive", title: `Источник ${i}`, reference: "" }],
    })),
    photos: Array.from({ length: 82 }, (_, i) => ({
      id: `f${i}`,
      url: `/media/f${i}.jpg`,
      title: `Снимок ${i}`,
      tags: [
        {
          id: `t${i}`,
          personId: `p${i % 2}`,
          x: 0,
          y: 0,
          width: 0.5,
          height: 0.5,
        },
      ],
    })),
  };
  const initial: ArchivePageHeader = {
    family: archiveOverview(family),
    revision: 1,
    partial: true,
    pageToken: "1:fixture",
    totals: { people: count, photos: family.photos!.length },
  };
  const calls: string[] = [],
    updates: ArchivePageHeader[] = [];
  const request = async (input: string) => {
    calls.push(input);
    const url = new URL(input, "http://local.test"),
      offset = Number(url.searchParams.get("offset"));
    assert.equal(url.searchParams.get("token"), initial.pageToken);
    if (url.searchParams.get("projection") === "details") {
      const ids = JSON.parse(url.searchParams.get("ids")!) as string[];
      const photos = family.photos!.filter((photo) =>
        photo.tags.some((tag) => ids.includes(tag.personId)),
      );
      return Response.json({
        pageToken: initial.pageToken,
        people: family.people
          .filter((p) => ids.includes(p.id))
          .map(personDetails),
        photos: photos.slice(offset, offset + 40),
        photoTotal: photos.length,
      });
    }
    assert.equal(url.searchParams.get("projection"), "page");
    const collection = url.searchParams.get("collection") as
      "people" | "photos";
    const items =
      collection === "people"
        ? family.people.map(personDetails)
        : family.photos!;
    return Response.json({
      pageToken: initial.pageToken,
      total: items.length,
      items: items.slice(offset, offset + 40),
    });
  };
  return {
    family,
    initial,
    calls,
    updates,
    request,
    reader: archiveDetails(initial, request, (data) => updates.push(data)),
  };
}

test("10,000-person archive starts without detail requests and opens only the requested card", async () => {
  const { reader, calls, updates, family } = fixture(10_000);
  assert.equal(calls.length, 0);
  await Promise.all([reader.loadPeople(["p120"]), reader.loadPeople(["p120"])]);
  assert.equal(calls.length, 1);
  assert.ok(reader.hasPerson("p120"));
  assert.equal(reader.hasPerson("p121"), false);
  const current = updates.at(-1)!.family;
  assert.equal(
    current.people.find((p) => p.id === "p120")!.biography,
    family.people[120].biography,
  );
  assert.equal(
    current.people.find((p) => p.id === "p121")!.biography,
    undefined,
  );
  assert.deepEqual(current.photos, []);
  assert.ok(calls.every((url) => url.includes("projection=details")));
  const edited = {
    ...current,
    people: current.people.map((p) =>
      p.id === "p120" ? { ...p, name: "Новое имя" } : p,
    ),
  };
  const changes = archiveChanges(current, edited);
  assert.deepEqual(
    changes.map((change) => [change.id, change.field]),
    [["p120", "name"]],
  );
  const applied = applyArchiveChanges(family, changes);
  assert.deepEqual(applied.conflicts, []);
  assert.deepEqual(
    applied.family.people[121].sources,
    family.people[121].sources,
  );
  assert.equal(
    applied.family.people[121].biography,
    family.people[121].biography,
  );
});

test("person album pages are deduplicated and collection demands preserve hydrated fields", async () => {
  const { reader, calls, updates, family } = fixture();
  await reader.loadPeople(["p0"]);
  assert.equal(calls.length, 2, "41 tagged photos require two bounded pages");
  assert.equal(updates.at(-1)!.family.photos!.length, 41);
  assert.ok(
    updates
      .at(-1)!
      .family.photos!.every((photo) => photo.tags[0].personId === "p0"),
  );
  await reader.loadCollections(["photos"]);
  assert.equal(reader.isComplete("people"), false);
  assert.equal(reader.isComplete("photos"), true);
  assert.equal(
    updates.at(-1)!.family.people[0].biography,
    family.people[0].biography,
  );
  assert.equal(updates.at(-1)!.family.photos!.length, 82);
  assert.ok(!calls.some((url) => url.includes("collection=people")));
  await reader.loadCollections(["people"]);
  assert.equal(updates.at(-1)!.partial, false);
  assert.deepEqual(updates.at(-1)!.family, family);
  const count = calls.length;
  await reader.loadPeople(["p1"]);
  await reader.loadCollections(["people", "photos"]);
  assert.equal(calls.length, count);
});

test("lazy reads recover one revision conflict via overview, never the full-family fallback", async () => {
  const { initial, family } = fixture();
  const calls: string[] = [],
    updates: ArchivePageHeader[] = [];
  const reader = archiveDetails(
    initial,
    async (url) => {
      calls.push(url);
      if (calls.length === 1) return Response.json({}, { status: 409 });
      if (url === "/api/family?projection=overview")
        return Response.json({
          ...initial,
          revision: 2,
          pageToken: "2:fixture",
        });
      assert.ok(url.includes("token=2%3Afixture"));
      return Response.json({
        pageToken: "2:fixture",
        people: [personDetails(family.people[2])],
        photos: [],
        photoTotal: 0,
      });
    },
    (data) => updates.push(data),
  );
  await reader.loadPeople(["p2"]);
  assert.equal(calls.length, 3);
  assert.ok(!calls.includes("/api/family"));
  assert.ok(updates.every((data) => data.revision === 2));
  assert.ok(reader.hasPerson("p2"));
});

test("revocation and repeated conflicts fail closed without publishing stale details or retrying forever", async () => {
  const { initial } = fixture();
  for (const status of [401, 403]) {
    const reader = archiveDetails(
      initial,
      async () => Response.json({ error: "revoked" }, { status }),
      () => assert.fail("no private publish"),
    );
    await assert.rejects(reader.loadPeople(["p2"]), ArchiveDetailsAccessError);
  }
  let calls = 0;
  const reader = archiveDetails(
    initial,
    async (url) => {
      calls++;
      return url.includes("projection=overview")
        ? Response.json(initial)
        : Response.json({}, { status: 409 });
    },
    () => {},
  );
  await assert.rejects(reader.loadPeople(["p2"]));
  assert.equal(calls, 3);
});

test("late detail replies cannot overwrite an already committed write", async () => {
  const { initial, family } = fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const updated = structuredClone(family);
  updated.people[2].biography = "Сохранённая новая биография";
  const publishes: ArchivePageHeader[] = [];
  let calls = 0;
  const reader = archiveDetails(
    initial,
    async (url) => {
      if (++calls === 1) {
        entered();
        await gate;
        return Response.json({
          pageToken: initial.pageToken,
          people: [personDetails(family.people[2])],
          photos: [],
          photoTotal: 0,
        });
      }
      assert.equal(url, "/api/family?projection=overview");
      return Response.json({
        ...initial,
        family: updated,
        revision: 2,
        partial: false,
      });
    },
    (value) => publishes.push(value),
  );
  const pending = reader.loadPeople(["p2"]);
  await ready;
  reader.replace(updated, 2, true);
  release();
  await pending;
  assert.ok(
    publishes.every(
      (header) =>
        header.family.people[2].biography === updated.people[2].biography,
    ),
  );
});

test("an overview refresh in flight cannot roll back a subsequently committed write", async () => {
  const { initial, family } = fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const updates: ArchivePageHeader[] = [];
  const updated = structuredClone(family);
  updated.people[2].biography = "Сохранено во время обновления";
  const reader = archiveDetails(
    initial,
    async (url) => {
      if (url.includes("projection=details"))
        return Response.json({}, { status: 409 });
      assert.equal(url, "/api/family?projection=overview");
      entered();
      await gate;
      return Response.json(initial);
    },
    (value) => updates.push(value),
  );
  const pending = reader.loadPeople(["p2"]);
  await ready;
  reader.replace(updated, 2, true);
  release();
  await pending;
  assert.equal(updates.length, 1);
  assert.equal(updates[0].revision, 2);
  assert.equal(
    updates[0].family.people[2].biography,
    updated.people[2].biography,
  );
  assert.equal(reader.hasPerson("p2"), true);
});
