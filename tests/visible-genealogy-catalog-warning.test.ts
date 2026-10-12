import assert from "node:assert/strict";
import test from "node:test";
import type { Family, Person, Source } from "../src/domain/types.ts";
import { visibleGenealogyHasCatalogLinks } from "../src/domain/visible-genealogy-catalog-warning.ts";
import { openArchive } from "../src/server/database.ts";
import { sourceCatalogStore } from "../src/server/source-catalog-store.ts";

const inline: Source = { title: "Register", type: "archive", reference: "p. 2", url: "https://example.test/register" };
const catalog: Source = { ...inline, catalogId: "catalog-entry" };
const person = (id: string): Person => ({
  id, surname: "Test", name: id, patronymic: "", sex: "u", birth: "", birthPlace: "",
  parents: [], spouses: [], generation: 0, column: 0, sources: [],
});
const family = (): Family => ({
  title: "Test", description: "", demo: false, people: [person("parent"), person("child"), person("hidden")],
});

test("visible person claims warn only for catalog links, not an inline citation with the same URL", () => {
  const data = family();
  data.people[1].sources = [inline];
  data.people[1].events = [{ id: "event", type: "work", dateClaim: { value: "1901", sources: [catalog] } }];
  assert.equal(visibleGenealogyHasCatalogLinks(data, new Set(["parent", "child"])), true);
  data.people[1].events = [];
  assert.equal(visibleGenealogyHasCatalogLinks(data, new Set(["parent", "child"])), false);
  data.people[2].occupationClaim = { value: "Teacher", sources: [catalog] };
  assert.equal(visibleGenealogyHasCatalogLinks(data, new Set(["parent", "child"])), false);
});

test("hidden parent, union participant, or link endpoint does not trigger a direct-export warning", () => {
  const data = family();
  data.people[1].parents = ["parent", "hidden"];
  data.people[1].parentClaims = [{ parentId: "hidden", sources: [catalog] }];
  data.unions = [{ id: "union", participants: ["child", "hidden"], type: "marriage", sources: [catalog] }];
  data.links = [{ id: "link", from: "child", to: "hidden", type: "godparent", sources: [catalog] }];
  const visible = new Set(["parent", "child"]);
  assert.equal(visibleGenealogyHasCatalogLinks(data, visible), false);
  data.people[1].parentClaims.push({ parentId: "parent", sources: [catalog] });
  assert.equal(visibleGenealogyHasCatalogLinks(data, visible), true);
  data.people[1].parentClaims = [];
  data.unions[0].participants = ["child", "parent"];
  assert.equal(visibleGenealogyHasCatalogLinks(data, visible), true);
  data.unions = [];
  data.links[0].to = "parent";
  assert.equal(visibleGenealogyHasCatalogLinks(data, visible), true);
});

test("SQL export warning projection matches visible citation semantics including relationships across a large ID set", async () => {
  const visible = new Set(["parent", "child"]);
  const cases: Family[] = [];
  const hidden = family();
  hidden.people[1].parents = ["parent", "hidden"];
  hidden.people[1].parentClaims = [{ parentId: "hidden", sources: [catalog] }];
  hidden.links = [{ id: "extra", from: "child", to: "hidden", type: "godparent", sources: [catalog] }];
  cases.push(hidden);
  const parentEvidence = structuredClone(hidden);
  parentEvidence.people[1].parentClaims!.push({ parentId: "parent", sources: [catalog] });
  cases.push(parentEvidence);
  const eventEvidence = family();
  eventEvidence.people[1].events = [{ id: "birth-register", type: "work", date: "1901", dateClaim: { value: "1901", sources: [catalog] } }];
  cases.push(eventEvidence);
  const extraEvidence = family();
  extraEvidence.links = [{ id: "extra", from: "child", to: "parent", type: "godparent", sources: [catalog] }];
  cases.push(extraEvidence);
  for (const data of cases) {
    data.people.forEach(person => { person.generation = 1; });
    const archive = await openArchive(":memory:", { title: "Test", description: "", demo: false, people: [] });
    try {
      await sourceCatalogStore(archive.db).insert({ id: "catalog-entry", title: inline.title, type: inline.type, reference: inline.reference, url: inline.url!, author: "", institution: "", archive: "", fond: "", opis: "", delo: "", sheet: "", accessedAt: "", description: "", documentIds: [] });
      await archive.write(data, (await archive.meta()).revision);
      const stored = (await archive.read()).family;
      const expectedCatalog = visibleGenealogyHasCatalogLinks(stored, visible);
      const expectedParent = stored.people.some(person => visible.has(person.id) && person.parentClaims?.some(claim => visible.has(claim.parentId)));
      archive.read = async () => { throw new Error("no full snapshot for export preflight"); };
      assert.deepEqual(await archive.exportWarnings(visible), { parentEvidence: expectedParent, catalogLinks: expectedCatalog });
    } finally { await archive.close(); }
  }
});
