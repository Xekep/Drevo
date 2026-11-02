import test from "node:test";
import assert from "node:assert/strict";
import { completeMarriageEndings, marriageDeathEnding, validateUnions } from "../src/domain/family-unions.ts";
import { archiveChanges, applyArchiveChanges } from "../src/domain/changes.ts";
import { applyPersonDraft } from "../src/domain/person-draft.ts";
import { applyPersonUnionDrafts } from "../src/domain/person-union-draft.ts";
import { kinshipPerson } from "./fixtures/kinship-graphs.ts";
import type { Family, FamilyUnion } from "../src/domain/types.ts";

const fixture = (): Family => ({ title: "Test", description: "", demo: false,
  people: [kinshipPerson("a"), kinshipPerson("b"), kinshipPerson("c")],
  unions: [{ id: "marriage", participants: ["a", "b"], type: "marriage", formation: { date: "1980" } }],
});

test("recording a spouse's death and ending the marriage is one reversible change", () => {
  const before = fixture();
  const edited = applyPersonDraft(before, { ...before.people[0], death: "2005-06-07" }, []);
  const after = completeMarriageEndings(edited);
  assert.equal(after.unions![0].ending?.date, "2005-06-07");
  assert.equal(before.unions![0].ending, undefined);
  validateUnions(after.unions, new Set(after.people.map(person => person.id)));
  assert.deepEqual(applyArchiveChanges(before, archiveChanges(before, after)).family, after);
  assert.deepEqual(applyArchiveChanges(after, archiveChanges(after, before)).family, before);
  assert.equal(completeMarriageEndings(after), after);
});

test("the earlier spouse death keeps its year/month precision and is visible from either profile", () => {
  const family = fixture();
  family.people[0].death = "2001-03";
  family.people[1].death = "2004-01-02";
  const people = new Map(family.people.map(person => [person.id, person]));
  assert.deepEqual(marriageDeathEnding(family.unions![0], people), { date: "2001-03" });
  family.people[1].death = "1999";
  assert.deepEqual(marriageDeathEnding(family.unions![0], people), { date: "1999" });
});

test("unknown deaths, non-marriages, prior marriages and conflicting ongoing evidence do not invent dates", () => {
  const family = fixture();
  family.people[0].deceased = true;
  assert.equal(completeMarriageEndings(family), family);
  family.people[0].death = "1979";
  assert.equal(completeMarriageEndings(family), family);
  family.people[0].death = "2000";
  for (const extra of [{ type: "partnership" as const }, { ongoing: { date: "2001" } }]) {
    const record = { ...family, unions: [{ ...family.unions![0], ...extra }] };
    assert.equal(completeMarriageEndings(record), record);
  }
});

test("a divorce, an undated ending and their sources are preserved", () => {
  for (const key of ["divorce", "ending"] as const) {
    const family = fixture();
    family.people[0].death = "2000";
    family.unions![0][key] = { sources: [{ title: "Акт", type: "", reference: "1" }] };
    assert.equal(completeMarriageEndings(family), family);
  }
});

test("automatic completion respects union permissions and affects only the edited person's marriages", () => {
  const family = fixture();
  family.people[0].death = "2000";
  family.people[2].death = "1990";
  family.unions!.push({ id: "other", participants: ["b", "c"], type: "marriage" });
  assert.equal(completeMarriageEndings(family, () => false), family);
  const after = completeMarriageEndings(family, () => true, "a");
  assert.equal(after.unions![0].ending?.date, "2000");
  assert.equal(after.unions![1].ending, undefined);
});

test("a divorce edited together with the death takes precedence over automatic completion", () => {
  const family = fixture();
  const edited = applyPersonDraft(family, { ...family.people[0], death: "2000" }, []);
  const draft: FamilyUnion = { ...family.unions![0], divorce: { date: "1995" } };
  const after = completeMarriageEndings(applyPersonUnionDrafts(edited, "a", family.unions!, [draft]));
  assert.equal(after.unions![0].divorce?.date, "1995");
  assert.equal(after.unions![0].ending, undefined);
});
