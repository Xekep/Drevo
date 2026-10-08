import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./postgres-fixture.ts";

test("document reference projection follows nested edits, deletions and archive separation", async (t) => {
  const { first } = await fixture(t);
  const migration = readFileSync(
    new URL(
      "../../ops/postgres/097_document_citation_index.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await first.query(migration);
  await first.query(migration);
  // The projection must use the established parent-evidence writer boundary.
  await first.query("SELECT set_config('drevo.parent_evidence_write','on',false)");
  await first.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  await first.query(`UPDATE people SET data = data || '{"sources":[{"documentId":"doc-a"}],"events":[{"sources":[{"documentId":"doc-a"},{"documentId":"doc-b"}]}]}'::jsonb
    WHERE archive_id='tree-a' AND id='own'`);
  const refs = () =>
    first.query(
      "SELECT document_id,kind,entity_id FROM document_citation_refs WHERE archive_id='tree-a' ORDER BY document_id",
    );
  assert.deepEqual((await refs()).rows, [
    { document_id: "doc-a", kind: "person", entity_id: "own" },
    { document_id: "doc-b", kind: "person", entity_id: "own" },
  ]);
  await first.query(
    `UPDATE people SET data=data-'sources'-'events' WHERE archive_id='tree-a' AND id='own'`,
  );
  assert.equal((await refs()).rowCount, 0);
  await first.query(
    `UPDATE relations SET sources='[{"documentId":"relation-doc"}]' WHERE archive_id='tree-a'`,
  );
  assert.equal((await refs()).rows[0].kind, "relation");
  await first.query("SELECT set_config('drevo.archive_id','tree-b',false)");
  await first.query(
    `UPDATE people SET data=data || '{"sources":[{"documentId":"other-doc"}]}'::jsonb WHERE archive_id='tree-b' AND id='own'`,
  );
  assert.equal(
    (await refs()).rows.some((row) => row.document_id === "other-doc"),
    false,
  );
  await first.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  await first.query("DELETE FROM relations WHERE archive_id='tree-a'");
  assert.equal((await refs()).rowCount, 0);
  const policy = (
    await first.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='document_citation_refs'::regclass",
    )
  ).rows[0];
  assert.deepEqual(policy, { relrowsecurity: true, relforcerowsecurity: true });
});
