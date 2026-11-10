import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type pg from "pg";
import { fixture } from "./postgres-fixture.ts";
import { provisionPrivateArchiveInTransaction } from "../../src/server/postgres-private-archive.ts";

test("ownership migration permits explicit staff trees, keeps registration idempotent and serializes transfers", async t => {
  const { first, second } = await fixture(t);
  await first.query(readFileSync(new URL("../../ops/postgres/111_multiple_owned_archives.sql", import.meta.url), "utf8"));
  const provision = async (client: pg.Client, owner: string, id: string, additional: boolean) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('drevo.account_id',$1,true),set_config('drevo.archive_id',$2,true)", [owner, id]);
      const result = await provisionPrivateArchiveInTransaction(client, owner, id, "Новое древо", 18, { additional });
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  };
  assert.deepEqual(await provision(first, "relative", "tree-extra", false), { archiveId: "tree-b", created: false });
  await assert.rejects(provision(first, "relative", "tree-extra", true), { code: "23505" });
  assert.equal((await first.query("SELECT 1 FROM archives WHERE id='tree-extra'")).rowCount, 0,
    "a rejected creation must roll back the archive and memberships");
  await first.query("INSERT INTO platform_researchers(account_id) VALUES('relative')");
  for (const id of ["tree-extra", "tree-extra-two"])
    assert.deepEqual(await provision(first, "relative", id, true), { archiveId: id, created: true });
  assert.equal((await first.query("SELECT archive_id FROM archive_owners WHERE user_id='relative'")).rowCount, 3);
  assert.equal((await provision(first, "relative", "tree-registration", false)).created, false);
  await first.query("BEGIN");
  await first.query("SELECT id FROM accounts WHERE id='relative' FOR UPDATE");
  await second.query("BEGIN");
  try {
    await assert.rejects(second.query("UPDATE archive_owners SET user_id='relative' WHERE archive_id='tree-a'"), { code: "55P03" });
  } finally { await second.query("ROLLBACK"); await first.query("ROLLBACK"); }
  await first.query("DELETE FROM platform_researchers WHERE account_id='relative'");
  await assert.rejects(provision(first, "relative", "tree-after-revoke", true), { code: "23505" });
  assert.equal((await first.query("SELECT archive_id FROM archive_owners WHERE user_id='relative'")).rowCount, 3);
  assert.equal((await provision(first, "admin", "tree-admin-extra", true)).created, true);
});
