import assert from "node:assert/strict";
import pg from "pg";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { openArchive } from "../../src/server/database.ts";
import { userStore } from "../../src/server/users.ts";
import { importSqliteSnapshot } from "../../ops/postgres/import-sqlite.ts";
import { auditStore } from "../../src/server/audit.ts";
import { archiveNotificationsStore } from "../../src/server/archive-notifications.ts";

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
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
      )
    ).rows[0].n,
    0,
    "The shared-connection probe needs its own empty disposable database",
  );
  // Other runtime fixtures intentionally leave encrypted provider cleanup rows.
  // Their private filesystem key cannot be reused by this independent server.
  const source = join(directory, "seed.sqlite");
  const uploads = join(directory, "uploads");
  await mkdir(uploads);
  delete process.env.DATABASE_BACKEND;
  const seed = await openArchive(source, {
    title: "Изолированная проверка",
    description: "",
    demo: false,
    people: [],
    links: [],
    photos: [],
  });
  try {
    await (
      await userStore(seed.db, { initialAdminId: "fixture-owner" })
    ).register("fixture-owner", "Владелец");
  } finally {
    await seed.close();
  }
  await importSqliteSnapshot(
    source,
    uploads,
    "shared-fixture",
    client,
    "fixture-owner",
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
  // Ordinary-role SQL exercises the notification dialect and RLS isolation.
  for (const db of [a, b]) await db.transaction(async () => {
    await auditStore(db).record({ action: "Добавлено", entity: "people", entityId: "same-id",
      label: "Historical private label", personIds: ["same-id"], details: [] },
    { id: "fixture-owner", name: "Владелец" });
  });
  const inboxA = archiveNotificationsStore(a);
  const inboxB = archiveNotificationsStore(b);
  const notificationsA = await inboxA.list("shared-probe-reader", null);
  const notificationsB = await inboxB.list("shared-probe-reader", null);
  assert.equal(notificationsA.unread, 1);
  assert.equal(notificationsB.unread, 1);
  assert.match(notificationsA.items[0].personName, /shared-probe-0/);
  assert.match(notificationsB.items[0].personName, /shared-probe-1/);
  assert.equal((await inboxA.list("shared-probe-reader", new Set())).unread, 0);
  assert.equal(await inboxA.read("shared-probe-reader", null, notificationsB.latest), false);
  assert.equal(await inboxA.read("shared-probe-reader", null, notificationsA.latest), true);
  assert.equal((await inboxA.list("shared-probe-reader", null)).unread, 0);
  assert.equal((await inboxB.list("shared-probe-reader", null)).unread, 1);
  await inboxB.readThrough("shared-probe-reader", null, notificationsB.latest);
  assert.equal((await inboxB.list("shared-probe-reader", null)).unread, 0);
  // Scope receipts must not suppress unseen events when access later expands.
  // Both inserts use the ordinary runtime role and the archive-local RLS scope.
  const scopePeople = ["scope-hidden", "scope-visible"];
  await a.transaction(async () => {
    for (const [index, id] of scopePeople.entries()) {
      await a.prepare("", "INSERT INTO people(id,ordinal,data) VALUES(?,?,?)")
        .run(id, index + 10, JSON.stringify({ ...person, id, name: id }));
      await auditStore(a).record({ action: "Добавлено", entity: "people", entityId: id,
        label: "Scope receipt probe", personIds: [id], details: [] },
      { id: "fixture-owner", name: "Владелец" });
    }
  });
  const onlyVisible = new Set(["scope-visible"]);
  const scopedInbox = await inboxA.list("shared-probe-reader", onlyVisible);
  assert.equal(scopedInbox.items.length, 1);
  await a.transaction(() => inboxA.readThrough("shared-probe-reader", onlyVisible, scopedInbox.latest));
  await a.transaction(() => inboxA.readThrough("shared-probe-reader", onlyVisible, scopedInbox.latest));
  await a.transaction(() => inboxA.readThrough("shared-probe-reader", new Set(), Number.MAX_SAFE_INTEGER));
  const expandedInbox = await inboxA.list("shared-probe-reader", new Set(scopePeople));
  assert.equal(expandedInbox.unread, 1);
  assert.equal(expandedInbox.items.find((item) => item.personId === "scope-hidden")?.read, false);
  assert.equal(expandedInbox.items.find((item) => item.personId === "scope-visible")?.read, true);
  assert.equal((await a.prepare("", "SELECT count(*)::int AS n FROM archive_notification_cursors").get())!.n, 0);
  assert.equal((await b.prepare("", "SELECT count(*)::int AS n FROM archive_notification_reads").get())!.n, 0);
  assert.equal((await inboxB.list("shared-probe-reader", null)).unread, 0);
  await a.transaction(async () => {
    for (const item of expandedInbox.items)
      await a.prepare("", "DELETE FROM archive_audit_entries WHERE id=?").run(item.id);
    for (const id of scopePeople)
      await a.prepare("", "DELETE FROM people WHERE id=?").run(id);
  });
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
  for (const index of [0, 1]) {
    const response = await fetch(`${base}/a/shared-probe-${index}/api/notifications`, { headers });
    assert.equal(response.status, 200);
    const inbox = await response.json();
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.unread, 0);
    assert.match(inbox.items[0].personName, new RegExp(`shared-probe-${index}`));
  }
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
