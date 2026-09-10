import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import type { ArchivePhoto, Family, Person } from "../src/domain/types.ts";

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

    const people = store.page("people", 1, 1) as Person[];
    assert.deepEqual(people.map((p) => p.id), ["b"]);
    assert.equal(people[0].sources[0].reference, "b");
    assert.deepEqual(people[0].parents, []);
    assert.deepEqual(people[0].spouses, []);

    const photos = store.page("photos", 0, 1) as ArchivePhoto[];
    assert.deepEqual(photos.map((photo) => photo.id), ["p1"]);
    assert.deepEqual(photos[0].tags.map((tag) => tag.id), ["t1"]);
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
    const people = store.page("people", 3, 1) as Person[];
    assert.deepEqual(people.map((p) => p.id), ["d"]);
  } finally {
    store.close();
  }
});
