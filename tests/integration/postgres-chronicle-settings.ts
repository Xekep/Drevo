import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { fixture, tokens, actor } from "./postgres-fixture.ts";
import {
  chronicleSettingsStore,
  ChronicleSettingsConflict,
  initializeChronicleConfiguration,
} from "../../src/server/chronicle-settings.ts";
import { defaultChronicleSettings } from "../../src/shared/chronicle-settings.ts";
import {
  postgresBindings,
  type StoreDatabase,
} from "../../src/server/store-database.ts";
import {
  PlatformAccessBusy,
  PlatformAccessDenied,
} from "../../src/server/platform-access.ts";
import { sessionTokenHash } from "../../src/server/session-token.ts";

test("chronicle settings share one row across archives; grants and sessions are locked through atomic saves", async (t) => {
  const { first, second, third } = await fixture(t);
  for (const file of [
    "091_platform_configuration.sql",
    "113_chronicle_settings.sql",
    "113_chronicle_settings.sql",
  ])
    await first.query(
      readFileSync(
        new URL(`../../ops/postgres/${file}`, import.meta.url),
        "utf8",
      ),
    );
  const db = (client: pg.Client, archiveId: string) =>
    ({
      kind: "postgres",
      file: ":test:",
      archiveId,
      prepare: (_sqlite: string, sql: string) => ({
        get: async (...values: unknown[]) =>
          (await client.query(postgresBindings(sql), values)).rows[0],
      }),
      postgresTransaction: async <T>(
        work: (client: pg.PoolClient) => Promise<T>,
      ) => {
        await client.query("BEGIN");
        try {
          const value = await work(client as unknown as pg.PoolClient);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      },
    }) as StoreDatabase;
  const a = chronicleSettingsStore(db(first, "tree-a")),
    b = chronicleSettingsStore(db(second, "tree-b"));
  const admin = {
    accountId: "admin",
    tokenHash: sessionTokenHash(tokens.admin),
  };
  const relative = {
    accountId: "relative",
    tokenHash: sessionTokenHash(tokens.relative),
  };
  assert.deepEqual(await a.read(), await b.read());
  await assert.rejects(
    b.save(defaultChronicleSettings, 0, actor, relative),
    PlatformAccessDenied,
  );
  assert.equal((await a.read()).version, 0);
  await first.query(
    "INSERT INTO platform_admins(account_id) VALUES('relative')",
  );
  await a.save(
    { ...defaultChronicleSettings, currentEffect: "ripple" },
    0,
    actor,
    admin,
  );
  assert.equal((await b.read()).settings.currentEffect, "ripple");
  const saves = await Promise.allSettled([
    a.save(
      { ...defaultChronicleSettings, currentEffect: "plasma" },
      1,
      actor,
      admin,
    ),
    b.save(
      { ...defaultChronicleSettings, currentEffect: "timeshift" },
      1,
      actor,
      relative,
    ),
  ]);
  assert.equal(saves.filter((value) => value.status === "fulfilled").length, 1);
  assert.ok(
    saves.some(
      (value) =>
        value.status === "rejected" &&
        value.reason instanceof ChronicleSettingsConflict,
    ),
  );
  const saved = await a.read();
  assert.equal(saved.version, 2);
  assert.deepEqual(await b.read(), saved);
  await first.query("DELETE FROM platform_admins WHERE account_id='relative'");
  await assert.rejects(
    b.save(defaultChronicleSettings, 2, actor, relative),
    PlatformAccessDenied,
  );
  await first.query(
    "INSERT INTO platform_admins(account_id) VALUES('relative')",
  );
  await third.query("BEGIN");
  await third.query("SELECT id FROM accounts WHERE id='relative' FOR UPDATE");
  await assert.rejects(
    b.save(defaultChronicleSettings, 2, actor, relative),
    PlatformAccessBusy,
  );
  await third.query("ROLLBACK");
  await first.query(
    "UPDATE account_sessions SET expires_at=0 WHERE user_id='relative'",
  );
  await assert.rejects(
    b.save(defaultChronicleSettings, 2, actor, relative),
    PlatformAccessDenied,
  );
  assert.deepEqual(await b.read(), saved);
  assert.equal(
    (
      await first.query(
        "SELECT count(*)::int AS n FROM platform_config_audit WHERE item_id='chronicle'",
      )
    ).rows[0].n,
    2,
  );
});

test("only the primary SQLite snapshot seeds platform chronicle settings and never overwrites live configuration", async (t) => {
  const { first } = await fixture(t);
  for (const file of [
    "002_service_snapshot.sql",
    "091_platform_configuration.sql",
  ])
    await first.query(
      readFileSync(
        new URL(`../../ops/postgres/${file}`, import.meta.url),
        "utf8",
      ),
    );
  await first.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  await first.query(`INSERT INTO service_snapshot_tables(archive_id,name,columns,row_count)
    VALUES('tree-a','platform_chronicle_settings','["id","version","data"]',1)`);
  await first.query(
    `INSERT INTO service_snapshot_rows(archive_id,table_name,ordinal,data)
    VALUES('tree-a','platform_chronicle_settings',1,$1::jsonb)`,
    [
      JSON.stringify({
        id: 1,
        version: 4,
        data: JSON.stringify({
          ...defaultChronicleSettings,
          currentEffect: "frost",
        }),
      }),
    ],
  );
  await first.query("BEGIN");
  await first.query("SELECT set_config('drevo.archive_id','tree-b',true)");
  await assert.rejects(
    initializeChronicleConfiguration(
      first as unknown as pg.PoolClient,
      "tree-a",
    ),
    /primary archive scope/,
  );
  await first.query("ROLLBACK");
  await first.query("BEGIN");
  await initializeChronicleConfiguration(
    first as unknown as pg.PoolClient,
    "tree-a",
  );
  await first.query("COMMIT");
  const imported = (
    await first.query(
      "SELECT version,data FROM platform_chronicle_settings WHERE id=1",
    )
  ).rows[0];
  assert.equal(imported.version, 4);
  assert.equal(imported.data.currentEffect, "frost");
  await first.query(
    "UPDATE platform_chronicle_settings SET version=5,data=$1::jsonb WHERE id=1",
    [JSON.stringify(defaultChronicleSettings)],
  );
  await first.query("BEGIN");
  await initializeChronicleConfiguration(
    first as unknown as pg.PoolClient,
    "tree-a",
  );
  await first.query("COMMIT");
  assert.equal(
    (
      await first.query(
        "SELECT version FROM platform_chronicle_settings WHERE id=1",
      )
    ).rows[0].version,
    5,
  );
});
