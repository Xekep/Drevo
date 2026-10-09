import test from "node:test";
import assert from "node:assert/strict";
import { applyPersonUnionDrafts } from "../src/domain/person-union-draft.ts";
import { applyPersonDraft } from "../src/domain/person-draft.ts";
import { archiveChanges, applyArchiveChanges } from "../src/domain/changes.ts";
import { kinshipPerson as person } from "./fixtures/kinship-graphs.ts";
import type { Family, FamilyUnion } from "../src/domain/types.ts";

const family = (): Family => ({
  title: "Test",
  description: "",
  demo: false,
  people: [
    { ...person("a"), spouses: ["b"] },
    { ...person("b"), spouses: ["a"] },
    person("c"),
  ],
  unions: [
    {
      id: "u",
      participants: ["a", "b"],
      type: "marriage",
      formation: {
        date: "1980",
        place: "Москва",
        sources: [{ title: "Акт", type: "", reference: "1" }],
      },
    },
  ],
});

test("person and marriage dates form one reversible archive change, preserving education and evidence", () => {
  const before = family();
  const edited = applyPersonDraft(
    before,
    {
      ...before.people[0],
      occupation: "Учитель",
      events: [
        { id: "school", type: "education", date: "1975", description: "Школа" },
      ],
    },
    [],
  );
  const draft = {
    ...before.unions![0],
    formation: { date: "1.5.1980" },
    divorce: { date: "09.1999" },
  };
  const after = applyPersonUnionDrafts(edited, "a", before.unions!, [draft]);
  const changes = archiveChanges(before, after);
  assert(changes.some((change) => change.collection === "people"));
  assert(changes.some((change) => change.collection === "unions"));
  assert.deepEqual(applyArchiveChanges(before, changes).family, after);
  assert.equal(after.unions![0].formation?.date, "1980-05-01");
  assert.equal(after.unions![0].formation?.place, "Москва");
  assert.deepEqual(
    after.unions![0].formation?.sources,
    before.unions![0].formation?.sources,
  );
  assert.equal(after.unions![0].divorce?.date, "1999-09");
  assert.deepEqual(
    applyArchiveChanges(after, archiveChanges(after, before)).family,
    before,
  );
});

test("concurrent union notes, citations and another union are retained, changed dates conflict", () => {
  const before = family();
  const fresh = structuredClone(before);
  fresh.unions![0].note = "Добавлено другим участником";
  fresh.unions![0].formation!.sources!.push({
    title: "Второй акт",
    type: "",
    reference: "2",
  });
  fresh.unions!.push({
    id: "other",
    participants: ["b", "c"],
    type: "partnership",
  });
  const draft: FamilyUnion = {
    ...before.unions![0],
    formation: { date: "1981" },
  };
  const result = applyPersonUnionDrafts(fresh, "a", before.unions!, [draft]);
  assert.equal(result.unions![0].note, fresh.unions![0].note);
  assert.deepEqual(
    result.unions![0].formation?.sources,
    fresh.unions![0].formation?.sources,
  );
  assert.deepEqual(result.unions![1], fresh.unions![1]);
  fresh.unions![0].formation!.date = "1982";
  assert.throws(
    () => applyPersonUnionDrafts(fresh, "a", before.unions!, [draft]),
    /другим участником/,
  );
  fresh.unions!.shift();
  assert.throws(
    () => applyPersonUnionDrafts(fresh, "a", before.unions!, [draft]),
    /Союз изменился/,
  );
});

test("new dated marriage requires an existing partner; invalid dates and reverse chronology are rejected", () => {
  const before = family();
  before.unions = [];
  const draft: FamilyUnion = {
    id: "new",
    participants: ["a", "b"],
    type: "marriage",
    formation: { date: "1990" },
    divorce: { date: "2000" },
  };
  assert.equal(
    applyPersonUnionDrafts(before, "a", [], [draft]).unions?.length,
    1,
  );
  assert.throws(
    () =>
      applyPersonUnionDrafts(
        before,
        "a",
        [],
        [{ ...draft, participants: ["a", "c"] }],
      ),
    /Сначала добавьте супруга/,
  );
  assert.throws(
    () =>
      applyPersonUnionDrafts(
        before,
        "a",
        [],
        [{ ...draft, formation: { date: "31.2.1990" } }],
      ),
    /Проверьте дату/,
  );
  assert.throws(
    () =>
      applyPersonUnionDrafts(
        before,
        "a",
        [],
        [{ ...draft, divorce: { date: "1980" } }],
      ),
    /раньше/,
  );
});

test("unchanged dates do not restore a removed union; clearing a date preserves an undated divorce's evidence", () => {
  const before = family();
  const deleted = { ...before, unions: [] };
  assert.equal(
    applyPersonUnionDrafts(deleted, "a", before.unions!, before.unions!),
    deleted,
  );
  before.unions![0].divorce = {
    date: "2000",
    sources: [{ title: "Развод", type: "", reference: "" }],
  };
  const draft = { ...before.unions![0], divorce: { date: undefined } };
  const after = applyPersonUnionDrafts(before, "a", before.unions!, [draft]);
  assert.equal(after.unions![0].divorce?.date, undefined);
  assert.deepEqual(
    after.unions![0].divorce?.sources,
    before.unions![0].divorce?.sources,
  );
});

test("a marriage added concurrently is not duplicated by a pending partner draft", () => {
  const before = family();
  before.unions = [];
  const fresh = structuredClone(before);
  fresh.unions = [
    { id: "concurrent", participants: ["a", "b"], type: "marriage" },
  ];
  const draft: FamilyUnion = {
    id: "pending",
    participants: ["a", "b"],
    type: "marriage",
    formation: { date: "1990" },
  };
  assert.throws(
    () => applyPersonUnionDrafts(fresh, "a", [], [draft]),
    /другим участником/,
  );
  assert.equal(fresh.unions.length, 1);
  assert.equal(fresh.unions[0].formation, undefined);
});
