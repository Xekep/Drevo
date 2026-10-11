import assert from "node:assert/strict";
import pg from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresConnections } from "../../src/server/postgres-connections.ts";
import { openPostgresDatabase } from "../../src/server/store-database.ts";
import { ARCHIVE_SCHEMA_VERSION } from "../../src/server/schema.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../../src/server/session-token.ts";
import { startServer } from "../../src/server/index.ts";

// This program is appended to the ordinary-role, disposable runtime CI only.
assert.match(
  process.env.PGDATABASE || "",
  /^drevo_migration_runtime_[a-z0-9_]+$/,
);
const client = new pg.Client();
await client.connect();
const shared = postgresConnections(6);
const directory = await mkdtemp(join(tmpdir(), "drevo-shared-connections-"));
let app: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  const role = (
    await client.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert.equal(role.rolsuper, false);
  assert.equal(role.rolbypassrls, false);
  assert.equal(
    (await client.query("SELECT current_database() AS name")).rows[0].name,
    process.env.PGDATABASE,
  );
  await client.query(
    "INSERT INTO accounts(id,name,created_at) VALUES('shared-probe-reader','Тестовый участник',$1)",
    [new Date().toISOString()],
  );
  const token = newSessionToken();
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'shared-probe-reader',$2)",
    [sessionTokenHash(token), Date.now() + 3_600_000],
  );
  const person = {
    id: "same-id",
    name: "",
    surname: "Тест",
    patronymic: "",
    sex: "u",
    birth: "1900",
    birthPlace: "",
    parents: [],
    spouses: [],
    sources: [],
    generation: 1,
    column: 0,
  };
  for (let i = 0; i < 100; i++) {
    const id = `shared-probe-${i}`;
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('drevo.archive_id',$1,true)", [id]);
      await client.query(
        "INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version) VALUES($1,$1,'',false,0,$2)",
        [id, ARCHIVE_SCHEMA_VERSION],
      );
      await client.query(
        "INSERT INTO people(archive_id,id,ordinal,data) VALUES($1,'same-id',0,$2)",
        [id, JSON.stringify({ ...person, name: id })],
      );
      await client.query(
        "INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES($1,'shared-probe-reader','reader',true,'all')",
        [id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const lease = await shared.connect(`shared-probe-${i}`);
      try {
        const rows = (
          await lease.client.query("SELECT data->>'name' AS name FROM people")
        ).rows;
        assert.deepEqual(rows, [{ name: `shared-probe-${i}` }]);
        await lease.client.query(
          "SELECT set_config('drevo.account_id','must-not-leak',false)",
        );
      } finally {
        await lease.release();
      }
    }),
  );
  assert.ok(shared.pool.totalCount <= 6);
  const naked = await shared.pool.connect();
  try {
    assert.ok(
      !(
        await naked.query(
          "SELECT current_setting('drevo.archive_id',true) AS archive,current_setting('drevo.account_id',true) AS account",
        )
      ).rows[0].archive,
    );
    assert.ok(
      !(
        await naked.query(
          "SELECT current_setting('drevo.account_id',true) AS account",
        )
      ).rows[0].account,
    );
    assert.equal((await naked.query("SELECT id FROM people")).rowCount, 0);
  } finally {
    naked.release();
  }
  const a = await openPostgresDatabase(
    "shared-probe-0",
    join(directory, "a.sqlite"),
    shared,
  );
  const b = await openPostgresDatabase(
    "shared-probe-1",
    join(directory, "b.sqlite"),
    shared,
  );
  await assert.rejects(
    a.transaction(async () => {
      await a
        .prepare(
          "",
          "UPDATE people SET data=jsonb_set(data,'{name}','\"rollback\"')",
        )
        .run();
      throw new Error("rollback probe");
    }),
  );
  assert.equal(
    (await b.prepare("", "SELECT data->>'name' AS name FROM people").get())
      ?.name,
    "shared-probe-1",
  );
  await a.close();
  assert.equal(
    (await b.prepare("", "SELECT data->>'name' AS name FROM people").get())
      ?.name,
    "shared-probe-1",
    "closing one view must not end the shared pool",
  );
  await b.close();

  process.env.DATABASE_BACKEND = "postgres";
  process.env.ARCHIVE_ID = "shared-probe-0";
  process.env.PUBLIC_ORIGIN = "https://isolated-benchmark.invalid";
  delete process.env.YANDEX_AI_API_KEY;
  app = await startServer(0, join(directory, "root.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const headers = { Cookie: `drevo_session=${token}` };
  const began = performance.now();
  // Opening is intentionally bounded; all 100 distinct runtimes remain live.
  for (let i = 0; i < 100; i++) {
    const response = await fetch(
      `${base}/a/shared-probe-${i}/api/family?projection=overview`,
      { headers },
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).family.people[0].name,
      `shared-probe-${i}`,
    );
  }
  const warmBegan = performance.now();
  await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const response = await fetch(
        `${base}/a/shared-probe-${i}/api/family?projection=overview`,
        { headers },
      );
      assert.equal(response.status, 200);
      assert.equal(
        (await response.json()).family.people[0].name,
        `shared-probe-${i}`,
      );
    }),
  );
  const directoryResponse = await fetch(
    `${base}/a/shared-probe-42/api/account/archives`,
    { headers },
  );
  assert.equal(directoryResponse.status, 200);
  const archives = (await directoryResponse.json()).archives;
  assert.equal(archives.length, 100);
  assert.equal(
    archives.filter((item: { current: boolean }) => item.current).length,
    1,
  );
  assert.equal(
    archives.find((item: { current: boolean }) => item.current).id,
    "shared-probe-42",
  );
  assert.ok(app.poolDiagnostics()!.total <= 10);
  console.log(
    JSON.stringify({
      operation: "100_distinct_archives",
      sequentialColdMs: warmBegan - began,
      warmBurstMs: performance.now() - warmBegan,
      errors: 0,
      pool: app.poolDiagnostics(),
    }),
  );
} finally {
  await app?.close();
  await shared.close();
  await client.end();
  await rm(directory, { recursive: true, force: true });
}
