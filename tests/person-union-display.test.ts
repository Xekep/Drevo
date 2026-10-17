import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { kinshipPerson } from "./fixtures/kinship-graphs.ts";
import { applyPersonUnionDrafts } from "../src/domain/person-union-draft.ts";
import type { Family, FamilyUnion } from "../src/domain/types.ts";

test("both profiles read one marriage and divorce, preserve unknown dates, and never expose an unavailable partner", async () => {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { PersonUnions } = await server.ssrLoadModule("/src/components/person-unions.tsx");
    const people = [
      { ...kinshipPerson("a"), name: "Иван", surname: "Иванов", spouses: ["b"] },
      { ...kinshipPerson("b"), name: "Анна", surname: "Иванова", spouses: ["a"] },
      { ...kinshipPerson("c"), name: "Пётр", surname: "Другой" },
    ];
    const union: FamilyUnion = { id: "shared", participants: ["a", "b"], type: "marriage",
      formation: { date: "1990", dateText: "около 1990 года", sources: [{ title: "Акт брака", type: "", reference: "42" }] },
      divorce: { date: "2001" } };
    const render = (personId: string, unions = [union], visible = people) => renderToStaticMarkup(
      createElement(PersonUnions, { personId, people: visible, unions,
        onSelect: () => {}, canLoadDocuments: false }),
    );
    const before = structuredClone(union);
    for (const id of ["a", "b"]) {
      const html = render(id);
      assert.match(html, /Заключение брака: <!-- -->1990 год|Заключение брака: 1990 год/);
      assert.match(html, /Развод: <!-- -->2001 год|Развод: 2001 год/);
      assert.match(html, /Акт брака/);
      assert.match(html, new RegExp(id === "a" ? "Иванова Анна" : "Иванов Иван"));
    }
    const family: Family = { title: "Test", description: "", demo: false, people, unions: [union] };
    const after = applyPersonUnionDrafts(family, "b", [union], [{ ...union, formation: { ...union.formation, date: "1991" } }]);
    for (const id of ["a", "b"]) {
      assert.match(render(id, after.unions), /1991 год/);
      assert.doesNotMatch(render(id, after.unions), /Заключение брака: (?:<!-- -->)?1990 год/);
      assert.match(render(id, after.unions), /По источнику: (?:<!-- -->)?около 1990 года/);
    }
    assert.equal(after.unions?.length, 1);
    assert.ok(after.people.every((person) => !person.events?.length));
    assert.deepEqual(union, before);
    assert.equal(render("c"), "");
    assert.equal(render("a", [union], people.filter((person) => person.id !== "b")), "");
    assert.equal(render("a", []), "");
    assert.match(render("a", [{ ...union, divorce: {} }]), /Развод: <!-- -->дата неизвестна|Развод: дата неизвестна/);
    assert.match(render("a", [{ ...union, formation: { dateText: "около 1990 года" } }]), /около 1990 года/);
    const remarried = render("a", [union, { ...union, id: "second", formation: { date: "2010" }, divorce: undefined }]);
    assert.equal((remarried.match(/class="life-event"/g) || []).length, 2);
    assert.match(remarried, /2010 год/);
  } finally {
    await server.close();
  }
});
