import test from "node:test";
import assert from "node:assert/strict";
import { archiveSummary, counted } from "../src/domain/archive-summary.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { analysisExport } from "../src/domain/analysis-export.ts";
import { ageLabel, years, hasRecordedDeath } from "../src/domain/dates.ts";
import { archiveChanges, applyArchiveChanges } from "../src/domain/changes.ts";
import { openArchive } from "../src/server/database.ts";
import type { Family, Person, PersonAward } from "../src/domain/types.ts";

const person = (
  id: string,
  parents: string[] = [],
  birth = "",
  death?: string,
): Person => ({
  id,
  name: id,
  surname: "Примеров",
  patronymic: "",
  sex: "u",
  parents,
  birth,
  death,
  birthPlace: "",
  spouses: [],
  sources: [],
  column: 0,
  generation: 77,
});
const family = (): Family => ({
  title: "Архив",
  description: "",
  demo: false,
  people: [person("one", [], "1900", "1943")],
});
const award: PersonAward = {
  id: "medal-1",
  name: "Медаль",
  year: "1945",
  source: { title: "Наградной лист", url: "https://example.org/document" },
};

test("summary counts longest known ancestry across components, ignores layout levels and spouse duplication", () => {
  const people = [
    person("child", ["parent", "other"], "1940-02"),
    person("root", [], "1875"),
    person("parent", ["root"], "1900"),
    person("other", [], "1907", "1998-05-02"),
    person("unrelated"),
  ];
  people[2].spouses = ["other", "unrelated"];
  const before = structuredClone(people);
  assert.deepEqual(archiveSummary(people), {
    people: 5,
    generations: 3,
    first: 1875,
    last: 1998,
    span: 123,
  });
  assert.deepEqual(people, before);
  assert.equal(archiveSummary([...people].reverse()).generations, 3);
});
test("summary preserves unknown dates, empty archive and a single recorded year", () => {
  assert.deepEqual(archiveSummary([]), {
    people: 0,
    generations: 0,
    first: undefined,
    last: undefined,
    span: undefined,
  });
  const unknown = archiveSummary([person("a"), person("b", ["a"])]);
  assert.equal(unknown.generations, 2);
  assert.equal(unknown.span, undefined);
  assert.deepEqual(archiveSummary([person("a", [], "1900")]), {
    people: 1,
    generations: 1,
    first: 1900,
    last: 1900,
    span: 0,
  });
  assert.equal(
    archiveSummary([person("a", ["b"]), person("b", ["a"])]).generations,
    null,
  );
  assert.equal(counted(21, ["год", "года", "лет"]), "21 год");
  assert.equal(counted(114, ["год", "года", "лет"]), "114 лет");
});
test("summary handles ten thousand generations iteratively", () => {
  const people = Array.from({ length: 10000 }, (_, i) =>
    person(String(i), i ? [String(i - 1)] : []),
  );
  assert.equal(archiveSummary(people).generations, 10000);
});
test("awards accept posthumous years, unknown details and repeated names with distinct ids", () => {
  const f = family();
  validateFamily(f);
  f.people[0].awards = [award, { id: "medal-2", name: "Медаль" }];
  assert.deepEqual(validateFamily(f).people[0].awards, f.people[0].awards);
  assert.deepEqual(
    JSON.parse(JSON.stringify(analysisExport(f, 1, "2026-01-01"))).people[0]
      .awards,
    f.people[0].awards,
  );
  for (const invalid of [
    { ...award, name: " " },
    { ...award, year: "1945-01" },
    { ...award, year: "9999" },
    { ...award, year: "0000" },
    { ...award, source: { title: "Источник", url: "javascript:alert(1)" } },
    { ...award, source: { title: "Источник", url: "https://?" } },
  ]) {
    const bad = structuredClone(f);
    bad.people[0].awards = [invalid];
    assert.throws(() => validateFamily(bad));
  }
  f.people[0].awards = [award, award];
  assert.throws(() => validateFamily(f));
});
test("awards persist in SQLite and respect ownership and revision conflicts", () => {
  const f = family();
  f.people[0].createdBy = "owner";
  const db = openArchive(":memory:", f);
  try {
    const next = structuredClone(f);
    next.people[0].awards = [award];
    const initial = db.read();
    for (const role of ["reader", "relative"] as const)
      assert.throws(() =>
        db.write(next, initial.revision, {
          id: "other",
          name: "Другой",
          role,
          createdAt: "2026-01-01",
        }),
      );
    const saved = db.write(next, initial.revision, {
      id: "owner",
      name: "Владелец",
      role: "relative",
      createdAt: "2026-01-01",
    });
    assert.deepEqual(db.read().family.people[0].awards, [award]);
    assert.throws(() => db.write(f, initial.revision));
    const edited = structuredClone(saved.family);
    edited.people[0].awards![0].name = "Уточнённое название";
    const changes = archiveChanges(saved.family, edited);
    const remote = structuredClone(saved.family);
    remote.people[0].biography = "Новая история";
    const merged = applyArchiveChanges(remote, changes);
    assert.equal(merged.conflicts.length, 0);
    assert.equal(merged.family.people[0].biography, "Новая история");
    remote.people[0].awards![0].year = "1946";
    assert.equal(
      applyArchiveChanges(remote, changes).conflicts[0].change.field,
      "awards",
    );
  } finally {
    db.close();
  }
});
test("a recorded death place without its date is not presented as a current age", () => {
  const p = person("a", [], "1900");
  assert.equal(hasRecordedDeath(p), false);
  p.deathPlace = "Место смерти";
  assert.equal(hasRecordedDeath(p), true);
  assert.equal(ageLabel(p), "");
  assert.equal(years(p), "1900 — ?");
});
