import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import { planAdditions } from "../src/domain/additions-import.ts";
import { removeImportedPeople } from "../src/domain/additions-undo.ts";
import {
  listAdditionBatches,
  planUndoAdditions,
} from "../src/server/additions-undo.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string): Person => ({
  id,
  name: id,
  surname: "Тест",
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
});
const family: Family = {
  title: "Архив",
  description: "Не менять",
  demo: false,
  people: [person("old")],
  photos: [],
  links: [],
};
const packet = (count: number) => ({
  format: "drevo.reviewed-add-only",
  version: 1,
  newPeople: Array.from({ length: count }, (_, i) => ({
    ...person(`new-${i}`),
    parents: ["old"],
  })),
});

test("undo removes unions wholly inside the import and preserves unrelated unions", () => {
  const current: Family = {
    ...family,
    people: [person("old"), person("other"), person("new-a"), person("new-b")],
    unions: [
      {
        id: "imported-union",
        type: "marriage",
        participants: ["new-a", "new-b"],
      },
      {
        id: "retained-union",
        type: "marriage",
        participants: ["old", "other"],
      },
    ],
  };
  const result = removeImportedPeople(current, new Set(["new-a", "new-b"]));
  assert.deepEqual(result.errors, []);
  assert.equal(result.connections, 1);
  assert.deepEqual(
    result.family.people.map((p) => p.id),
    ["old", "other"],
  );
  assert.deepEqual(result.family.unions, [current.unions![1]]);
  assert.equal(
    current.unions!.length,
    2,
    "the preview does not mutate its input",
  );
});

test("undo previews a union crossing the import boundary without changing retained people", () => {
  const current: Family = {
    ...family,
    people: [person("old"), person("new-a")],
    unions: [
      { id: "crossing", type: "marriage", participants: ["old", "new-a"] },
    ],
  };
  const result = removeImportedPeople(current, new Set(["new-a"]));
  assert.match(result.errors[0], /семейный союз.*вне импорта/);
  assert.equal(result.family, current);
});

test("undo identifies all 382 imported IDs even after snapshot history expires and preserves later unrelated edits", async () => {
  const archive = await openArchive(":memory:", family);
  try {
    const initial = await archive.read();
    const plan = planAdditions(initial.family, packet(382), "admin");
    const imported = await archive.write(
      plan.family,
      initial.revision,
      undefined,
      "import_additions",
    );
    let current = imported;
    for (let i = 0; i < 51; i++) {
      const next = structuredClone(current.family);
      next.people[0].biography = `Поздняя правка ${i}`;
      current = await archive.write(next, current.revision);
    }
    const extra = structuredClone(current.family);
    extra.people.push(person("unrelated-later"));
    extra.people = extra.people.filter((p) => p.id !== "new-0");
    extra.people.find((p) => p.id === "new-1")!.biography =
      "Изменение импортированной карточки";
    current = await archive.write(extra, current.revision);
    const batches = await listAdditionBatches(archive.db);
    assert.equal(batches[0].count, 382);
    const undo = await planUndoAdditions(
      archive.db,
      current.family,
      imported.revision,
    );
    assert.equal(undo.preview.people.length, 381);
    assert.equal(undo.preview.alreadyRemoved, 1);
    assert.equal(undo.preview.editedCount, 1);
    assert.equal(undo.preview.errorCount, 0);
    assert.deepEqual(
      undo.family.people,
      extra.people.filter((p) => !p.id.startsWith("new-")),
    );
    assert(
      undo.changes.every(
        (c) =>
          c.collection === "people" &&
          c.after === undefined &&
          c.id?.startsWith("new-"),
      ),
    );
    assert.deepEqual(
      (await archive.read()).family,
      current.family,
      "preview must not write",
    );
    const saved = await archive.write(undo.family, current.revision);
    assert.equal(saved.family.people.length, 2);
    assert.deepEqual(saved.family.people[0], current.family.people[0]);
  } finally {
    await archive.close();
  }
});

test("undo blocks ID reuse and cannot select arbitrary revisions or IDs from another archive", async () => {
  const archive = await openArchive(":memory:", family);
  const other = await openArchive(":memory:", family);
  try {
    const current = await archive.read();
    const imported = await archive.write(
      planAdditions(current.family, packet(1), "admin").family,
      current.revision,
      undefined,
      "import_additions",
    );
    await assert.rejects(
      planUndoAdditions(other.db, family, imported.revision),
      /не найден/,
    );
    await assert.rejects(
      planUndoAdditions(archive.db, family, current.revision),
      /не найден/,
    );
    await assert.rejects(
      planUndoAdditions(archive.db, family, "2"),
      /Выберите/,
    );
    const removed = await archive.write(family, imported.revision);
    const recreated = await archive.write(
      {
        ...family,
        people: [
          ...family.people,
          { ...person("new-0"), name: "Другой человек" },
        ],
      },
      removed.revision,
    );
    const undo = await planUndoAdditions(
      archive.db,
      recreated.family,
      imported.revision,
    );
    assert(undo.preview.errors.some((e) => e.includes("заново")));
    assert.deepEqual(undo.family, recreated.family);
    assert.deepEqual(undo.changes, []);
  } finally {
    await archive.close();
    await other.close();
  }
});

test("outside cards and new cross-branch connections block undo; photographs and surviving tags are retained", () => {
  const imported = { ...person("new"), parents: ["old"] };
  const linked = {
    ...family,
    people: [{ ...person("old"), parents: ["new"] }, person("new")],
  };
  assert(removeImportedPeople(linked, new Set(["new"])).errors.length);
  const crossing: Family = {
    ...family,
    people: [...family.people, imported],
    links: [{ id: "extra", from: "old", to: "new", type: "godparent" }],
  };
  assert(removeImportedPeople(crossing, new Set(["new"])).errors.length);
  const tag = (id: string) => ({
    id,
    personId: id,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  const withPhoto: Family = {
    ...family,
    people: [...family.people, imported],
    photos: [
      {
        id: "photo",
        title: "Оригинал",
        url: "/media/photo.png",
        tags: [tag("old"), tag("new")],
      },
    ],
  };
  const undo = removeImportedPeople(withPhoto, new Set(["new"]));
  assert.equal(undo.errors.length, 0);
  assert.equal(undo.photoTags, 1);
  assert.deepEqual(undo.family.photos, [
    { ...withPhoto.photos![0], tags: [tag("old")] },
  ]);
  assert.deepEqual(undo.family.people, family.people);
  assert.equal(withPhoto.photos![0].tags.length, 2);
});
