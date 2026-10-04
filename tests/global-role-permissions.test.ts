import assert from "node:assert/strict";
import test from "node:test";
import type { ArchiveUser } from "../src/domain/access.ts";
import { canAssessArchiveEvidence, canEditArchive, isArchiveOwner } from "../src/domain/access.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import type { Family, Person } from "../src/domain/types.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { ForbiddenError } from "../src/server/users.ts";

const person = (id: string, createdBy: string, parents: string[] = []): Person => ({
  id,
  name: id,
  surname: "Synthetic",
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  parents,
  spouses: [],
  generation: parents.length ? 2 : 1,
  column: 0,
  sources: [],
  createdBy,
});

const family = (): Family => {
  const ancestor = person("ancestor", "owner");
  const self = person("self", "staff", [ancestor.id]);
  self.parentClaims = [{ parentId: ancestor.id,
    sources: [{ title: "Visible register", type: "book", reference: "p. 1" }],
    confidence: "probable" }];
  self.birth = "1900";
  self.birthDateClaim = { value: "1900", sources: [{
    title: "Birth ledger", type: "book", reference: "p. 2",
  }], confidence: "probable" };
  const hiddenParent = person("hidden-parent", "owner");
  const hiddenChild = person("hidden-child", "owner", [hiddenParent.id]);
  const ownCard = person("own-card", "staff", [hiddenParent.id]);
  ownCard.parentClaims = [{ parentId: hiddenParent.id,
    sources: [{ title: "Hidden parent register", type: "archive", reference: "secret" }] }];
  return { title: "Synthetic roles", description: "", demo: false,
    people: [ancestor, self, hiddenParent, hiddenChild, ownCard], photos: [],
    links: [], unions: [] };
};

const member = (overrides: Partial<ArchiveUser> = {}): ArchiveUser => ({
  id: "staff", name: "Synthetic staff", role: "relative", treeRole: "relative",
  globalRole: null, archiveOwner: false, approved: true, createdAt: "2026-01-01",
  treeAccess: "all", ...overrides,
});

test("archive ownership permits editing other cards but does not grant confidence assessment", () => {
  const before = family();
  const owner = member({ id: "owner", archiveOwner: true });
  const edit = structuredClone(before);
  edit.people.find((item) => item.id === "hidden-parent")!.name = "Corrected";
  assert.equal(authorizeArchive(edit, before, owner).people.find((item) =>
    item.id === "hidden-parent")?.name, "Corrected");

  const assessment = structuredClone(before);
  assessment.people.find((item) => item.id === "self")!.parentClaims![0].confidence = "confirmed";
  assert.throws(() => authorizeArchive(assessment, before, owner), ForbiddenError);
  assert.equal(canAssessArchiveEvidence(owner), false);
});

test("global researcher assesses an own parent and date claim without becoming archive owner", () => {
  const before = family();
  const researcher = member({ globalRole: "researcher" });
  const assessment = structuredClone(before);
  const self = assessment.people.find((item) => item.id === "self")!;
  self.parentClaims![0].confidence = "confirmed";
  self.birthDateClaim!.confidence = "confirmed";
  const saved = authorizeArchive(assessment, before, researcher);
  assert.equal(saved.people.find((item) => item.id === "self")?.parentClaims?.[0].confidence,
    "confirmed");
  assert.equal(saved.people.find((item) => item.id === "self")?.birthDateClaim?.confidence,
    "confirmed");

  const foreign = structuredClone(before);
  foreign.people.find((item) => item.id === "hidden-parent")!.name = "Taken over";
  assert.throws(() => authorizeArchive(foreign, before, researcher), ForbiddenError);
  assert.equal(isArchiveOwner(researcher), false);

  const catalog = structuredClone(before);
  catalog.people.find((item) => item.id === "self")!.parentClaims![0].sources!.push({
    catalogId: "foreign-catalog", title: "Catalogue", type: "archive", reference: "A-1",
  });
  assert.throws(() => authorizeArchive(catalog, before,
    member({ globalRole: "admin" })), ForbiddenError);
});

test("a local reader cannot edit or assess despite a global staff grant", () => {
  const before = family();
  const changed = structuredClone(before);
  const self = changed.people.find((item) => item.id === "self")!;
  self.name = "Changed";
  self.parentClaims![0].confidence = "confirmed";
  for (const globalRole of ["admin", "researcher"] as const) {
    const reader = member({ role: "reader", treeRole: "reader", globalRole });
    assert.equal(canEditArchive(reader), false);
    assert.equal(canAssessArchiveEvidence(reader), false);
    assert.equal(isArchiveOwner(reader), false);
    assert.throws(() => authorizeArchive(changed, before, reader), ForbiddenError);
  }
});

test("scoped global staff sees its own card but not another branch or its parent citations", () => {
  const before = family();
  const scoped = member({ globalRole: "researcher", personId: "self",
    treeAccess: "common_ancestors" });
  const visible = projectFamilyForUser(before, scoped);
  assert.deepEqual(visible.people.map((item) => item.id).sort(),
    ["ancestor", "own-card", "self"]);
  assert.deepEqual(visible.people.find((item) => item.id === "self")?.parents,
    ["ancestor"]);
  assert.equal(visible.people.find((item) => item.id === "self")?.parentClaims?.[0]
    .sources?.[0].title, "Visible register");
  const ownCard = visible.people.find((item) => item.id === "own-card")!;
  assert.deepEqual(ownCard.parents, []);
  assert.deepEqual(ownCard.parentClaims, []);
  assert.ok(!JSON.stringify(visible).includes("Hidden parent register"));
  assert.ok(!JSON.stringify(visible).includes("hidden-parent"));
  assert.deepEqual(before.people.find((item) => item.id === "own-card")?.parents,
    ["hidden-parent"], "projection does not mutate stored family");
});
