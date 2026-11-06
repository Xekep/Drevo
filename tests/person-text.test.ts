import assert from "node:assert/strict";
import test from "node:test";
import { normalizeArchivePersonText, normalizePersonText, normalizePersonTextChanges } from "../src/domain/person-text.ts";
import { applyArchiveChanges, type Change } from "../src/domain/changes.ts";
import { matchesPerson } from "../src/domain/dates.ts";
import type { Family, Person } from "../src/domain/types.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { openArchive } from "../src/server/database.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

const person = (id = "a"): Person => ({ id, createdBy: "local", surname: "Иванов",
  name: "Иван", patronymic: "", sex: "u", birth: "", birthPlace: "",
  parents: [], spouses: [], sources: [], generation: 1, column: 0 });
const family = (): Family => ({ title: "Тест", description: "", demo: false,
  people: [person(), person("b")] });
const actor: ArchiveUser = { id: "local", name: "Тест", role: "admin", approved: true, createdAt: "" };

test("short person fields trim Unicode edge whitespace while prose, identifiers and internal spaces survive", () => {
  const raw = { ...person(), surname: "\u00a0Иванов\u00a0", name: "\tИван\n",
    patronymic: "   ", maidenName: " Петров ", birthPlace: "  Нижний  Новгород  ",
    deathPlace: " Омск ", occupation: "  мастер  кузнечного дела  ",
    biography: "    Код\nстрока с переносом  \n", photo: "/media/original.webp",
    sources: [{ title: " Источник ", type: "", reference: " ф. 1 ", note: "  цитата\n  " }] };
  const snapshot = structuredClone(raw);
  const saved = normalizePersonText(raw);
  assert.deepEqual([saved.surname, saved.name, saved.patronymic, saved.maidenName,
    saved.birthPlace, saved.deathPlace, saved.occupation],
  ["Иванов", "Иван", "", "Петров", "Нижний  Новгород", "Омск", "мастер  кузнечного дела"]);
  assert.equal(saved.biography, raw.biography);
  assert.equal(saved.id, raw.id);
  assert.equal(saved.photo, raw.photo);
  assert.deepEqual(saved.sources, raw.sources);
  assert.deepEqual(raw, snapshot);
  assert.ok(matchesPerson(saved, "  Иванов Иван  "));
});

test("trimming preserves a fact's evidence and assessment but never attaches it to a different value", () => {
  const raw = { ...person(), birthPlace: " Омск ", birthPlaceClaim: {
    value: " Омск ", confidence: "confirmed" as const,
    sources: [{ title: "Книга", type: "", reference: "л. 1" }] } };
  const saved = normalizePersonText(raw);
  assert.equal(saved.birthPlace, "Омск");
  assert.deepEqual(saved.birthPlaceClaim, { ...raw.birthPlaceClaim, value: "Омск" });
  assert.equal(raw.birthPlaceClaim.value, " Омск ");
  const wrong = normalizePersonText({ ...raw, birthPlace: " Москва " });
  assert.throws(() => validateFamily({ ...family(), people: [wrong] }), /Источник места рождения/);
});

test("normalization does not clean unchanged cards or coerce malformed input", () => {
  const before = family();
  before.people[1].name = " Старая запись ";
  const submitted = structuredClone(before);
  submitted.people[0].name = " Пётр ";
  const after = validateFamily(normalizeArchivePersonText(submitted, before));
  assert.equal(after.people[0].name, "Пётр");
  assert.deepEqual(after.people[1], before.people[1]);
  for (const people of [[null], [{ ...person(), name: 42 }], [{ ...person(), birthPlaceClaim: [] }]])
    assert.throws(() => validateFamily(normalizeArchivePersonText({ ...family(), people })));
});

test("delta retries compare canonical after-values and keep exact before-values for stale conflict checks", () => {
  const before = family();
  before.people[0].name = " Иван ";
  const change: Change = { collection: "people", id: "a", field: "name", before: " Иван ", after: " Пётр " };
  const normalized = normalizePersonTextChanges([change]);
  assert.equal(normalized[0].before, " Иван ");
  assert.equal(change.after, " Пётр ");
  const applied = applyArchiveChanges(before, normalized);
  assert.deepEqual(applied.conflicts, []);
  assert.equal(applied.family.people[0].name, "Пётр");
  assert.deepEqual(applyArchiveChanges(applied.family, normalized).conflicts, []);
  assert.equal(applyArchiveChanges(before, normalizePersonTextChanges([{ ...change, before: "Иван" }])).conflicts.length, 1);
});

test("full-snapshot authorization retains ownership and assessed-fact protection after trimming", () => {
  const before = family();
  before.people[0].occupation = " Учитель ";
  before.people[0].occupationClaim = { value: " Учитель ", confidence: "confirmed",
    sources: [{ title: "Трудовая книжка", type: "", reference: "л. 2" }] };
  const editor: ArchiveUser = { ...actor, role: "relative", treeRole: "relative",
    globalRole: null, archiveOwner: false };
  const next = structuredClone(before);
  next.people[0] = normalizePersonText(next.people[0]);
  assert.equal(authorizeArchive(next, before, editor).people[0].occupationClaim!.value, "Учитель");
  const otherValue = structuredClone(next);
  otherValue.people[0].occupation = "Врач";
  otherValue.people[0].occupationClaim!.value = "Врач";
  assert.throws(() => authorizeArchive(otherValue, before, editor), /достоверности/);
  const foreign = structuredClone(before);
  foreign.people[0].createdBy = "other";
  assert.throws(() => authorizeArchive(next, foreign, editor), /только свои/);
});

test("live archive writers store trimmed values, preserve neighboring legacy cards and retry without a new revision", async () => {
  const archive = await openArchive(":memory:", family());
  try {
    // Synthetic old data: normalization is a save boundary, not a destructive migration.
    const legacy = { ...person("b"), name: " Старая запись " };
    await archive.db.prepare("UPDATE people SET data=? WHERE id=?").run(JSON.stringify(legacy), "b");
    const initial = await archive.read();
    const changes: Change[] = [{ collection: "people", id: "a", field: "name", before: "Иван", after: "\u00a0Пётр\u00a0" },
      { collection: "people", id: "a", field: "birthPlace", before: "", after: " Омск " }];
    const result = await archive.patchPeople(changes, initial.revision, actor);
    assert.ok(result);
    assert.ok(result.appliedChanges.every(change => change.id === "a"));
    const saved = await archive.read();
    assert.equal(saved.family.people[0].name, "Пётр");
    assert.equal(saved.family.people[0].birthPlace, "Омск");
    assert.equal(saved.family.people[1].name, legacy.name);
    const retried = await archive.patchPeople(changes, initial.revision, actor);
    assert.equal(retried!.revision, saved.revision);
    assert.deepEqual(retried!.appliedChanges, []);
    const added = { ...person("c"), name: " Анна ", occupation: " Педагог " };
    await archive.patchChanges([{ collection: "people", id: "c", before: undefined, after: added }], saved.revision, actor);
    const latest = await archive.read();
    assert.equal(latest.family.people.find(person => person.id === "c")!.occupation, "Педагог");
    assert.equal(latest.family.people[1].name, legacy.name);
    const full = structuredClone(latest.family);
    full.people[0].surname = " Сидоров ";
    await archive.write(full, latest.revision, actor);
    const written = await archive.read();
    assert.equal(written.family.people[0].surname, "Сидоров");
    assert.equal(written.family.people[1].name, legacy.name);
  } finally { await archive.close(); }
});
