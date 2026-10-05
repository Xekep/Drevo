import test from "node:test";
import assert from "node:assert/strict";
import { fixture, tokens, person } from "./postgres-fixture.ts";
import { patchPostgresPeopleForSession } from "../../src/server/postgres-person-patches.ts";
import { changePostgresGraphForSession } from "../../src/server/postgres-graph-changes.ts";

test("raw PostgreSQL fast writers cannot bypass full award-citation validation", async (t) => {
  const { first } = await fixture(t);
  const award = { id: "award", name: "Медаль", sources: [{
    title: "Чужой документ", type: "архив", reference: "л. 1",
    catalogId: "foreign-catalog",
  }] };
  await assert.rejects(patchPostgresPeopleForSession(first, tokens.admin, "tree-a",
    [{ collection: "people", id: "father", field: "awards",
      before: undefined, after: [award] }], 0),
  /Ожидаются изменения полей существующих карточек/);
  await assert.rejects(changePostgresGraphForSession(first, tokens.admin, "tree-a",
    [{ collection: "people", id: "award-person",
      before: undefined,
      after: { ...person("award-person", "1990"), awards: [award] } }], 0),
  /Цитаты наград требуют полной проверки архива/);
  assert.equal((await first.query("SELECT count(*)::integer AS n FROM people WHERE archive_id='tree-a' AND id='award-person'"))
    .rows[0].n, 0);
  assert.equal((await first.query("SELECT count(*)::integer AS n FROM people WHERE archive_id='tree-b' AND id='award-person'"))
    .rows[0].n, 0);
});
