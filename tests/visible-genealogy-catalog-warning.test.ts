import assert from "node:assert/strict";
import test from "node:test";
import type { Family, Person, Source } from "../src/domain/types.ts";
import { visibleGenealogyHasCatalogLinks } from "../src/domain/visible-genealogy-catalog-warning.ts";

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
