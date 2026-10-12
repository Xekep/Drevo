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

test("an urgent photo read preserves canonical collection order and completes before the next background batch", async () => {
  const setup = fixture(2);
  setup.family.photos = Array.from({ length: 210 }, (_, index) => ({
    id: `f${index}`,
    url: `/media/${index}.jpg`,
    title: String(index),
    tags: [],
  }));
  setup.initial.totals!.photos = 210;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const calls: string[] = [];
  let latest = setup.initial;
  const reader = archiveDetails(
    setup.initial,
    async (input) => {
      const params = new URL(input, "http://local.test").searchParams;
      calls.push(input);
      if (params.get("projection") === "photos")
        return Response.json({
          pageToken: setup.initial.pageToken,
          photos: [setup.family.photos![205]],
        });
      const offset = Number(params.get("offset"));
      if (!offset) {
        entered();
        await gate;
      }
      return Response.json({
        pageToken: setup.initial.pageToken,
        total: 210,
        items: setup.family.photos!.slice(offset, offset + 40),
      });
    },
    (header) => {
      latest = header;
    },
  );
  const collection = reader.loadCollections(["photos"]);
  await ready;
  const card = reader.loadPhotos(["f205"]);
  release();
  await card;
  await collection;
  assert.ok(
    calls.findIndex((url) => url.includes("projection=photos")) <
      calls.findIndex((url) => url.includes("offset=160")),
  );
  assert.deepEqual(
    latest.family.photos!.map((photo) => photo.id),
    setup.family.photos.map((photo) => photo.id),
  );
});

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
        photos: photos.slice(0, 30),
        photoTotal: photos.length,
        personPhotoTotals: Object.fromEntries(ids.map(id => [id, family.photos!.filter(photo => photo.tags.some(tag => tag.personId === id)).length])),
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

test("card reads run between collection batches, preserving hydrated fields", async () => {
  const f = fixture(210);
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const reader = archiveDetails(
    f.initial,
    async (input) => {
      const url = new URL(input, "http://local.test");
      if (
        url.searchParams.get("projection") === "page" &&
        url.searchParams.get("offset") === "0"
      ) {
        started();
        await blocked;
      }
      return f.request(input);
    },
    (data) => f.updates.push(data),
  );
  const collection = reader.loadCollections(["people"]);
  await begun;
  const card = reader.loadPeople(["p205"]);
  release();
  await card;
  assert.equal(reader.isComplete("people"), false);
  await collection;
  const cardIndex = f.calls.findIndex((url) =>
    url.includes("projection=details"),
  );
  const nextBatch = f.calls.findIndex((url) => url.includes("offset=160"));
  assert.ok(cardIndex >= 0 && cardIndex < nextBatch);
  assert.equal(
    f.updates.at(-1)!.family.people[205].biography,
    f.family.people[205].biography,
  );
  assert.equal(reader.isComplete("people"), true);
});

test("profile reads only one album preview and preserves its actual total", async () => {
  const { reader, calls, updates, family } = fixture();
  await reader.loadPeople(["p0"]);
  assert.equal(calls.length, 1, "opening a card never downloads its whole album");
  assert.equal(updates.at(-1)!.family.photos!.length, 30);
  assert.equal(reader.personPhotoTotal("p0"), 41);
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
        personPhotoTotals: { p2: 0 },
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
          personPhotoTotals: { p2: 0 },
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

test("leaving a collection view aborts its reads without completing the collection or requesting later batches", async () => {
  const setup = fixture(1000);
  const controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [];
  const reader = archiveDetails(setup.initial, async (url, init) => {
    calls.push(url);
    entered();
    await new Promise<void>((resolve, reject) => {
      if (init?.signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
      else init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    return setup.request(url);
  }, () => assert.fail("aborted page must not publish"));
  const pending = reader.loadCollections(["people"], controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls.length, 4, "only the already dispatched bounded group starts");
  assert.equal(reader.isComplete("people"), false);
  assert.ok(calls.every(url => !url.includes("offset=160")));
});

test("a minimal committed write invalidates the selected profile preview and reloads its true album total once", async () => {
  const setup = fixture(1);
  const photos = setup.family.photos!.filter(photo => photo.tags.some(tag => tag.personId === "p0"));
  let latest = setup.initial, revision = 1, total = photos.length, calls = 0;
  const reader = archiveDetails(setup.initial, async input => {
    const params = new URL(input, "https://example.test").searchParams;
    assert.equal(params.get("projection"), "details");
    assert.equal(params.get("preview"), "1");
    assert.equal(params.get("offset"), "0");
    assert.equal(params.get("token"), `${revision}:fixture`);
    calls++;
    return Response.json({ pageToken: `${revision}:fixture`, people: [personDetails(setup.family.people[0])], photos: photos.slice(0, 30), photoTotal: total, personPhotoTotals: { p0: total } });
  }, header => { latest = header; });
  await reader.loadPeople(["p0"]);
  assert.equal(reader.personPhotoTotal("p0"), 41);
  assert.equal(reader.projectionGeneration(), 0);
  revision = 2;
  total = 42;
  reader.replace({ ...latest.family, people: latest.family.people.map(person => ({ ...person, name: "Updated" })) }, revision, false);
  assert.equal(reader.hasPerson("p0"), true, "committed card fields remain loaded");
  assert.equal(reader.personPhotoTotal("p0"), undefined, "an old count cannot survive a new archive revision");
  assert.equal(reader.projectionGeneration(), 1, "App depends on this revision marker even when the reader and selected ID stay unchanged");
  await reader.loadPeople(["p0"]);
  assert.equal(reader.personPhotoTotal("p0"), 42);
  assert.equal(latest.family.photos!.length, 30, "reloading still fetches only a bounded cover preview");
  await reader.loadPeople(["p0"]);
  assert.equal(calls, 2, "publishing fresh profile data never invalidates its projection again or loops");
  assert.equal(reader.projectionGeneration(), 1);
});

test("a shared profile preview does not complete an album whose photos fell outside the first thirty", async () => {
  const setup = fixture(3);
  setup.family.photos = setup.family.photos!.map((photo, index) => ({
    ...photo,
    tags: photo.tags.map(tag => ({ ...tag, personId: index < 41 ? "p0" : "p1" })),
  }));
  await setup.reader.loadPeople(["p0", "p1", "p2"]);
  assert.equal(setup.calls.length, 1);
  assert.equal(setup.reader.personPhotoTotal("p0"), 41);
  assert.equal(setup.reader.personPhotoTotal("p1"), 41);
  assert.equal(setup.reader.personPhotoTotal("p2"), 0);
  assert.ok(setup.updates.at(-1)!.family.photos!.every(photo => photo.tags.every(tag => tag.personId === "p0")));
  await setup.reader.loadPeople(["p1"]);
  assert.equal(setup.calls.length, 2, "a known total alone does not replace that person's missing cover preview");
  const solo = new URL(setup.calls[1], "https://example.test").searchParams;
  assert.deepEqual(JSON.parse(solo.get("ids")!), ["p1"]);
  assert.equal(solo.get("preview"), "1");
  assert.equal(solo.get("offset"), "0");
  assert.equal(setup.updates.at(-1)!.family.photos!.filter(photo => photo.tags.some(tag => tag.personId === "p1")).length, 30);
  await setup.reader.loadPeople(["p0", "p1", "p2"]);
  assert.equal(setup.calls.length, 2, "covered and genuinely empty albums are ready without repeat reads");
});
