import test from "node:test";
import assert from "node:assert/strict";
import { planAdditions } from "../src/domain/additions-import.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string, birth = "1900"): Person => ({
  id,
  name: id,
  surname: "Пример",
  patronymic: "",
  sex: "m",
  birth,
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
});
const seed = (): Family => ({
  title: "Архив",
  description: "Сохранить",
  demo: false,
  people: [
    {
      ...person("old", "1870"),
      biography: "Не менять",
      needsReview: false,
      photo: "/media/portrait.jpg",
    },
  ],
  photos: [{ id: "photo", title: "Снимок", url: "/media/photo.jpg", tags: [] }],
  links: [],
});
const pack = (newPeople: unknown[], newLinks: unknown[] = []) => ({
  format: "drevo.reviewed-add-only",
  version: 1,
  existingPeople: [],
  newPeople,
  newLinks,
});

test("382 insertions preserve every old card, media and metadata; source IDs and review flags survive", () => {
  const original = seed(),
    before = structuredClone(original);
  const additions = Array.from({ length: 382 }, (_, i) => ({
    ...person(`new-${i}`),
    parents: ["old"],
    needsReview: false,
    sources: [{ title: "Публикация", type: "Книга", reference: `с. ${i + 1}` }],
  }));
  const result = planAdditions(original, pack(additions), "actor");
  assert.deepEqual(original, before);
  assert.deepEqual(result.family.people[0], original.people[0]);
  assert.deepEqual(result.family.photos, original.photos);
  assert.equal(result.family.description, original.description);
  assert.equal(result.family.people.length, 383);
  assert.equal(result.preview.people.length, 382);
  assert.equal(result.preview.errorCount, 0);
  assert.equal(result.preview.detachedPeople, 0);
  assert(
    result.changes.every(
      (c) => c.before === undefined && c.field === undefined && c.id !== "old",
    ),
  );
  assert(
    result.family.people
      .slice(1)
      .every(
        (p) =>
          p.createdBy === "actor" && p.needsReview && p.sources.length === 1,
      ),
  );
  assert.throws(
    () => planAdditions(result.family, pack(additions), "actor"),
    /уже существует/,
  );
});
test("rejects updates, replacement exports, forged fields, media, duplicate IDs and unknown relationships", () => {
  const p = person("new");
  for (const value of [
    { ...pack([p]), existingPeople: [{ id: "old" }] },
    { ...pack([p]), changes: [] },
    { ...pack([p]), format: "drevo.genealogy" },
    pack([{ ...p, id: "old" }]),
    pack([p, p]),
    pack([{ ...p, createdBy: "other" }]),
    pack([{ ...p, photo: "/media/secret.jpg" }]),
    pack([{ ...p, parents: ["missing"] }]),
    JSON.parse(
      '{"format":"drevo.reviewed-add-only","version":1,"__proto__":{},"newPeople":[]}',
    ),
  ])
    assert.throws(() => planAdditions(seed(), value, "actor"));
});
test("all-or-nothing graph validation rejects cycles and asymmetric or existing-spouse writes", () => {
  assert.throws(() =>
    planAdditions(
      seed(),
      pack([{ ...person("new"), parents: ["new"] }]),
      "actor",
    ),
  );
  for (const people of [
    [{ ...person("new"), spouses: ["old"] }],
    [{ ...person("a"), spouses: ["b"] }, person("b")],
  ])
    assert(planAdditions(seed(), pack(people), "actor").preview.errorCount > 0);
  assert.throws(
    () =>
      planAdditions(
        seed(),
        pack(
          [person("a")],
          [{ id: "link", from: "old", to: "a", type: "godparent" }],
        ),
        "actor",
      ),
    /только между новыми/,
  );
});
test("chronology checks original dates, posthumous births, incomplete years, and marriages after spouse death", () => {
  const run = (people: Person[]) =>
    planAdditions({ ...seed(), people: [] }, pack(people), "actor").preview;
  assert(
    run([
      { ...person("father", "1816"), death: "1846-02-21" },
      { ...person("child", "1869-09-23"), parents: ["father"] },
    ]).errorCount > 0,
  );
  assert.equal(
    run([
      { ...person("father", "1902"), death: "1927-02-28" },
      { ...person("child", "1927-04-02"), parents: ["father"] },
    ]).errorCount,
    0,
  );
  assert(
    run([
      { ...person("mother", "1902"), sex: "f", death: "1927-02-28" },
      { ...person("child", "1927-04-02"), parents: ["mother"] },
    ]).errorCount > 0,
  );
  assert.equal(
    run([
      { ...person("mother", "1902"), sex: "f", death: "1927" },
      { ...person("child", "1927"), parents: ["mother"] },
    ]).errorCount,
    0,
  );
  assert(
    run([
      {
        ...person("husband", "1870"),
        spouses: ["wife"],
        events: [{ id: "marriage", type: "marriage", date: "1939-10-21" }],
      },
      {
        ...person("wife", "1873"),
        sex: "f",
        spouses: ["husband"],
        death: "1936-08-15",
      },
    ]).errorCount > 0,
  );
  assert.equal(run([person("unknown", "")]).errorCount, 0);
});
test("shows isolated branches and possible duplicates without merging or inventing parentage", () => {
  const original = seed();
  const duplicate = { ...original.people[0], id: "new" };
  delete duplicate.photo;
  const result = planAdditions(original, pack([duplicate]), "actor");
  assert.equal(result.preview.detachedPeople, 1);
  assert.equal(result.family.people[0].parents.length, 0);
  assert(result.preview.warnings.some((w) => w.includes("дубль")));
});
