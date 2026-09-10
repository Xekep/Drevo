import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string): Person => ({
  id,
  surname: "Тест",
  name: id,
  patronymic: "",
  sex: "u",
  birth: "1950",
  birthPlace: "",
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [{ title: `Источник ${id}`, type: "archive", reference: id }],
});

const seed: Family = {
  title: "Постраничный архив",
  description: "",
  demo: false,
  people: [person("a"), person("b"), person("c")],
  photos: [
    {
      id: "p1",
      url: "/media/p1.jpg",
      title: "Первое фото",
      tags: [
        { id: "t1", personId: "a", x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      ],
    },
    {
      id: "p2",
      url: "/media/p2.jpg",
      title: "Второе фото",
      tags: [],
    },
  ],
};

test("storage exposes cheap archive metadata and stable row pages", () => {
  const store = openArchive(":memory:", seed);
  try {
    const meta = store.meta();
    assert.equal(meta.revision, 1);
    assert.equal(meta.people, 3);
    assert.equal(meta.photos, 2);

    const people = store.peoplePage(1, 1);
    assert.deepEqual(people.map((p) => p.id), ["b"]);
    assert.equal(people[0].sources[0].reference, "b");
    assert.deepEqual(people[0].parents, []);
    assert.deepEqual(people[0].spouses, []);

    const photos = store.photoPage(0, 1);
    assert.deepEqual(photos.map((photo) => photo.id), ["p1"]);
    assert.deepEqual(photos[0].tags.map((tag) => tag.id), ["t1"]);
  } finally {
    store.close();
  }
});

test("overview reads the graph without heavy person fields or photo rows", () => {
  const linked = structuredClone(seed);
  linked.people[0].spouses = ["b"];
  linked.people[1].spouses = ["a"];
  linked.people[2].parents = ["a", "b"];
  linked.people[0].biography = "Большая биография, которая не нужна раскладке";
  linked.people[0].photo = "/media/portrait.jpg";
  const store = openArchive(":memory:", linked);
  try {
    const hiddenPortraits = store.overview(false),
      a = hiddenPortraits.family.people.find((p) => p.id === "a")!,
      c = hiddenPortraits.family.people.find((p) => p.id === "c")!;
    assert.equal(hiddenPortraits.revision, 1);
    assert.deepEqual(hiddenPortraits.totals, { people: 3, photos: 2 });
    assert.equal(hiddenPortraits.family.photos?.length, 0);
    assert.deepEqual(a.sources, []);
    assert.equal(a.biography, undefined);
    assert.equal(a.photo, undefined);
    assert.deepEqual(a.spouses, ["b"]);
    assert.deepEqual(c.parents, ["a", "b"]);

    const withPortraits = store.overview(true);
    assert.equal(
      withPortraits.family.people.find((p) => p.id === "a")!.photo,
      "/media/portrait.jpg",
    );
  } finally {
    store.close();
  }
});

test("page reads see the latest revision without rebuilding relationships", () => {
  const store = openArchive(":memory:", seed);
  try {
    const first = store.read();
    const next = structuredClone(first.family);
    next.people.push(person("d"));
    store.write(next, first.revision);
    assert.equal(store.meta().revision, 2);
    assert.equal(store.meta().people, 4);
    assert.deepEqual(store.peoplePage(3, 1).map((p) => p.id), ["d"]);
  } finally {
    store.close();
  }
});
