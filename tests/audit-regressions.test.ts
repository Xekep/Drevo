import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import { rebasePersonDraft } from "../src/domain/person-draft.ts";
import { validateFamily } from "../src/domain/validation.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string): Person => ({
  id, name: id, surname: "Тестов", patronymic: "", sex: "u", birth: "",
  birthPlace: "", parents: [], spouses: [], sources: [], generation: 1, column: 0,
});

test("rebase of an open person draft preserves independent server fields", () => {
  const base = person("one"), fresh = { ...base, surname: "Серверов" },
    draft = { ...base, name: "Локальное имя" };
  assert.deepEqual(rebasePersonDraft(base, fresh, draft), {
    ...fresh,
    name: "Локальное имя",
  });
});

test("relationship reorder does not cascade-delete face descriptors", () => {
  const family: Family = {
    title: "Тест", description: "", demo: false,
    people: [person("one"), person("two"), person("three")], photos: [],
  };
  const archive = openArchive(":memory:", family);
  try {
    archive.db.prepare(
      "INSERT INTO face_descriptors(id,person_id,data) VALUES(?,?,?)",
    ).run("sample", "one", JSON.stringify(Array(128).fill(0)));
    const state = archive.read();
    state.family.people[2].parents = ["one"];
    const saved = archive.write(state.family, state.revision);
    saved.family.people[1].parents = ["one"];
    archive.write(saved.family, saved.revision);
    assert.equal(
      archive.db.prepare("SELECT count(*) AS n FROM face_descriptors").get()!.n,
      1,
    );
  } finally {
    archive.close();
  }
});

test("supported maximum-depth input does not overflow the JavaScript stack", () => {
  const people = Array.from({ length: 10_000 }, (_, index) => ({
    ...person(`p${index}`),
    parents: index ? [`p${index - 1}`] : [],
  })).reverse();
  assert.equal(validateFamily({
    title: "Глубокий тест", description: "", demo: false, people, photos: [],
  }).people.length, 10_000);
});

test("photo tag lookup uses the photo_id index", () => {
  const archive = openArchive(":memory:", {
    title: "Тест", description: "", demo: false, people: [person("one")], photos: [],
  });
  try {
    const plan = archive.db.prepare(
      "EXPLAIN QUERY PLAN SELECT photo_id,data FROM photo_tags WHERE photo_id IN (?) ORDER BY rowid",
    ).all("photo").map((row) => String(row.detail)).join(" ");
    assert.match(plan, /photo_tags_photo/);
  } finally {
    archive.close();
  }
});
