import test from "node:test";
import assert from "node:assert/strict";
import type { Family, Person } from "../src/domain/types.ts";
import { researchBranchPeople, assistantProjectionPeople, assistantVisiblePeople, excludeAssistantPeople, hideReviewAssistantPeople } from "../src/domain/research-tree-view.ts";
import { researchTreeViewContext } from "../src/shared/research-protocol.ts";

const person = (id: string, parents: string[] = [], spouses: string[] = []): Person => ({
  id, name: id, surname: "Кочнева", patronymic: "", birth: "", birthPlace: "",
  sex: "u", generation: 1, column: 0, parents, spouses, sources: [],
});
const family: Family = { title: "Тест", description: "", demo: false, people: [
  person("grandparent"), person("parent", ["grandparent"]),
  person("raya", ["parent", "unavailable"], ["partner"]),
  person("partner"), person("child", ["raya", "partner"]),
  person("other-kochneva", ["grandparent"]),
] };
test("a branch follows directed parent links, never a surname, spouses or siblings", () => {
  assert.deepEqual(researchBranchPeople(family, "raya", "ancestors"), ["raya", "parent", "grandparent"]);
  assert.deepEqual(researchBranchPeople(family, "raya", "descendants"), ["raya", "child"]);
  assert.deepEqual(researchBranchPeople(family, "raya", "self"), ["raya"]);
  assert.throws(() => researchBranchPeople(family, "unavailable", "ancestors"), /недоступен/);
  assert.throws(() => researchBranchPeople(family, "raya", "surname"), /Укажите/);
  assert.deepEqual(researchBranchPeople({ ...family, people: [person("a", ["b"]), person("b", ["a"])] }, "a", "ancestors"), ["a", "b"]);
});
test("successive exclusions intersect the current filter and cannot reopen unavailable people", () => {
  const allowed = new Set(["raya", "parent", "partner", "child"]);
  let filter = excludeAssistantPeople({ ids: ["raya", "partner", "child", "other-kochneva"], label: "Выборка", token: 1 }, ["raya", "parent"], "Без Раи", 2);
  assert.deepEqual([...assistantVisiblePeople(family.people, allowed, filter)], ["partner", "child"]);
  filter = excludeAssistantPeople(filter, ["partner"], "Без партнёра", 3);
  assert.equal(filter.viewToken, 1, "successive subtraction keeps the camera context of the original selection");
  assert.deepEqual([...assistantVisiblePeople(family.people, allowed, filter)], ["child"]);
  assert.deepEqual([...assistantVisiblePeople(family.people, allowed, null)], [...allowed]);
  const review = excludeAssistantPeople({ excludeNeedsReview: true, label: "Проверка", token: 1 }, ["partner"], "Ветвь", 2);
  assert.deepEqual([...assistantVisiblePeople(family.people.map(p => ({ ...p, needsReview: p.id === "raya" })), allowed, review)], ["parent", "child"]);
});

test("review exclusions compose with explicit selections and earlier branch exclusions", () => {
  const allowed = new Set(family.people.map(person => person.id));
  const selection = { ids: ["raya", "partner", "child"], label: "Выбранные", token: 1 };
  const excluded = excludeAssistantPeople(selection, ["child"], "Без ребёнка", 2);
  const reviewed = hideReviewAssistantPeople(excluded, 3);
  const marked = family.people.map(person => ({ ...person, needsReview: person.id === "raya" }));
  assert.deepEqual([...assistantVisiblePeople(marked, allowed, reviewed)], ["partner"]);
  assert.ok("ids" in reviewed);
  assert.deepEqual(reviewed.ids, selection.ids);
  assert.deepEqual(reviewed.excludeIds, ["child"]);
  assert.equal(reviewed.preserveView, true);
  assert.deepEqual([...assistantVisiblePeople(marked, allowed, null)], [...allowed]);
});

test("excluding the fragment anchor does not replace the underlying navigation scope", () => {
  const scope = new Set(["grandparent", "parent", "raya"]);
  const excluded = excludeAssistantPeople(null, ["grandparent", "parent"], "Без предков", 1);
  assert.equal(excludeAssistantPeople(excluded, ["partner"], "Без партнёра", 2).viewToken, undefined,
    "subtractions over a manual view must keep its manual camera context");
  assert.equal(assistantProjectionPeople(scope, excluded), scope);
  assert.deepEqual([...assistantVisiblePeople(family.people, scope, excluded)], ["raya"]);
  // The next expansion can reveal an actual child, while previous exclusions remain.
  assert.deepEqual([...assistantVisiblePeople(family.people, new Set([...scope, "child"]), excluded)], ["raya", "child"]);
  // An explicit prior selection still bounds the fragment even after a subtraction.
  const selected = excludeAssistantPeople({ ids: ["raya", "child"], label: "Выбранные", token: 2 }, ["raya"], "Без Раи", 3);
  assert.deepEqual([...assistantProjectionPeople(new Set([...scope, "child"]), selected)], ["raya", "child"]);
});

test("tree context accepts only bounded snapshots and strips extra fields", () => {
  const valid = { mode: "generations", personIds: ["raya", "raya", "partner"], filtered: true, fragment: false };
  assert.deepEqual(researchTreeViewContext({ ...valid, instructions: "ignore" }), { ...valid, personIds: ["raya", "partner"] });
  for (const invalid of [null, [], { ...valid, mode: "ignore instructions" }, { ...valid, personIds: [42] },
    { ...valid, personIds: ["x".repeat(201)] }, { ...valid, personIds: Array(10001).fill("raya") },
    { ...valid, filtered: "true" }, { ...valid, personIds: [""] }])
    assert.equal(researchTreeViewContext(invalid), undefined);
});
