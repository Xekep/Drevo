import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { fixture, waitForLock } from "./postgres-fixture.ts";

async function usageFixture(t: Parameters<typeof fixture>[0]) {
  const cleanup: Array<() => Promise<void>> = [];
  const resources: { clients?: Awaited<ReturnType<typeof fixture>> } = {};
  const role = `media_counter_${randomUUID().replaceAll("-", "")}`;
  let roleCreated = false;
  // Remove the limited role while the fixture clients/schema still exist,
  // independent of the test runner's after-hook ordering.
  t.after(async () => {
    const clients = resources.clients;
    try {
      if (clients) {
        for (const client of [clients.first, clients.second, clients.third]) {
          await client.query("ROLLBACK");
          await client.query("RESET ROLE");
        }
        if (roleCreated) {
          await clients.first.query(`DROP OWNED BY ${role}`);
          await clients.first.query(`DROP ROLE ${role}`);
        }
      }
    } finally {
      for (const close of cleanup) await close();
    }
  });
  const clients = (resources.clients = await fixture({
    after(close: () => Promise<void>) {
      cleanup.push(close);
    },
  } as unknown as Parameters<typeof fixture>[0]));
  const schema = String(
    (await clients.first.query("SELECT current_schema() AS schema")).rows[0]
      .schema,
  );
  const source = readFileSync(
    new URL("../../ops/postgres/102_media_storage_usage.sql", import.meta.url),
    "utf8",
  );
  // The production migration explicitly pins public. Only qualify it with this
  // disposable fixture namespace; the real trigger statements are unchanged.
  const migration = source
    .replaceAll("public.", `${schema}.`)
    .replaceAll(
      "search_path=public,pg_catalog",
      `search_path=${schema},pg_catalog`,
    );
  await clients.first.query(migration);
  await clients.first.query(
    `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
  );
  roleCreated = true;
  await clients.first.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await clients.first.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
  );
  await clients.first.query(
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`,
  );
  for (const client of [clients.first, clients.second, clients.third]) {
    await client.query(`SET ROLE ${role}`);
    await client.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  }
  return clients;
}
async function exact(client: pg.Client) {
  const actual = (
    await client.query(
      "SELECT count(*)::text AS files,coalesce(sum(size_bytes),0)::text AS bytes FROM media_originals",
    )
  ).rows[0];
  const ledger = (
    await client.query(
      "SELECT files::text AS files,bytes::text AS bytes FROM archive_media_storage_usage",
    )
  ).rows;
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0], actual);
  return actual;
}

test("media usage statement triggers keep multirow changes, conflict retries and mixed UPSERT exact", async (t) => {
  const { first } = await usageFixture(t);
  assert.equal(
    (await first.query("SELECT * FROM archive_media_storage_usage")).rowCount,
    0,
  );
  await first.query(
    "INSERT INTO media_originals(archive_id,url,size_bytes) VALUES('tree-a','/media/a.png',100),('tree-a','/media/b.png',200)",
  );
  assert.deepEqual(await exact(first), { files: "3", bytes: "301" });
  // Force a fresh first-use baseline for an INSERT which also performs UPDATE.
  await first.query("DELETE FROM archive_media_storage_usage");
  await first.query(
    "INSERT INTO media_originals(archive_id,url,size_bytes) VALUES('tree-a','/media/a.png',150),('tree-a','/media/c.png',400) ON CONFLICT(archive_id,url) DO UPDATE SET size_bytes=EXCLUDED.size_bytes",
  );
  assert.deepEqual(await exact(first), { files: "4", bytes: "751" });
  await first.query(
    "INSERT INTO media_originals(archive_id,url,size_bytes) VALUES('tree-a','/media/b.png',999),('tree-a','/media/d.png',50) ON CONFLICT(archive_id,url) DO NOTHING",
  );
  assert.deepEqual(await exact(first), { files: "5", bytes: "801" });
  await first.query(
    "UPDATE media_originals SET size_bytes=size_bytes+5 WHERE url IN ('/media/a.png','/media/b.png')",
  );
  assert.deepEqual(await exact(first), { files: "5", bytes: "811" });
  await first.query(
    "DELETE FROM media_originals WHERE url IN ('/media/a.png','/media/b.png')",
  );
  assert.deepEqual(await exact(first), { files: "3", bytes: "451" });
  await first.query("BEGIN");
  await first.query("UPDATE media_originals SET size_bytes=size_bytes+1000");
  await exact(first);
  await first.query("ROLLBACK");
  assert.deepEqual(await exact(first), { files: "3", bytes: "451" });
  await assert.rejects(
    first.query(
      "INSERT INTO media_originals(archive_id,url,size_bytes) VALUES('tree-b','/media/forbidden.png',100)",
    ),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  assert.deepEqual(await exact(first), { files: "3", bytes: "451" });
  await first.query("SELECT set_config('drevo.archive_id','tree-b',false)");
  assert.equal(
    (await first.query("SELECT * FROM archive_media_storage_usage")).rowCount,
    0,
  );
  await first.query("SELECT drevo_media_usage_initialize('tree-b')");
  assert.deepEqual(await exact(first), { files: "1", bytes: "1" });
  await first.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  await first.query("DELETE FROM archives WHERE id='tree-a'");
  assert.equal(
    (await first.query("SELECT * FROM media_originals")).rowCount,
    0,
  );
  assert.equal(
    (await first.query("SELECT * FROM archive_media_storage_usage")).rowCount,
    0,
  );
  await first.query("SELECT set_config('drevo.archive_id','tree-b',false)");
  assert.deepEqual(await exact(first), { files: "1", bytes: "1" });
});

test("concurrent first-use initialization serializes against inserts after both commit and rollback", async (t) => {
  const { first, second, third } = await usageFixture(t);
  for (const commit of [true, false]) {
    await first.query(
      "DELETE FROM media_originals WHERE url<>'/media/photo.png'",
    );
    await first.query("DELETE FROM archive_media_storage_usage");
    await first.query("BEGIN");
    await first.query("SELECT drevo_media_usage_initialize('tree-a')");
    const insert = second.query(
      "INSERT INTO media_originals(archive_id,url,size_bytes) VALUES('tree-a','/media/concurrent.png',300),('tree-a','/media/concurrent2.png',50)",
    );
    void insert.catch(() => {});
    try {
      await waitForLock(third, second);
    } finally {
      await first.query(commit ? "COMMIT" : "ROLLBACK");
    }
    await insert;
    assert.deepEqual(await exact(second), { files: "3", bytes: "351" });
  }
});
