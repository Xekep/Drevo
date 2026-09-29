import assert from "node:assert/strict";
import { vkAuthSettingsStore } from "../../src/server/vk-auth-settings.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import PDFDocument from "pdfkit";
import {
  newSessionToken,
  sessionTokenHash,
} from "../../src/server/session-token.ts";
import { openPostgresDatabase } from "../../src/server/store-database.ts";
import { backupCoordinator } from "../../src/server/backup-coordinator.ts";
import { openArchive } from "../../src/server/database.ts";
import { userStore } from "../../src/server/users.ts";
import { settingsStore } from "../../src/server/settings.ts";
import {
  aiSettingsStore,
  aiRuntimeConfig,
  defaultAiRoleProfile,
} from "../../src/server/ai-settings.ts";
import { aiChatStore } from "../../src/server/ai-chats.ts";
import { aiUsageStore } from "../../src/server/ai-usage.ts";
import { accountAiAccess } from "../../src/server/account-ai-access.ts";
import { accountCapacity } from "../../src/server/account-capacity.ts";
import { mcpTokenStore } from "../../src/server/mcp-tokens.ts";
import { treePreferencesStore } from "../../src/server/tree-preferences.ts";
import { importSqliteSnapshot } from "../../ops/postgres/import-sqlite.ts";
import { writeDatabaseBackup } from "../../src/server/backup.ts";
import { startServer } from "../../src/server/index.ts";
import {
  BASIC_MEDIA_BYTES,
  enforcePostgresMediaQuota,
  releaseAttachedMediaGrants,
} from "../../src/server/postgres-media-quota.ts";
import { UploadQuotaError } from "../../src/server/upload-quota.ts";
import type { Family } from "../../src/domain/types.ts";

if (!/^drevo_migration_runtime_[a-z0-9_]+$/.test(process.env.PGDATABASE || ""))
  throw new Error("Use a NEW disposable drevo_migration_runtime_* database");
const client = new pg.Client();
await client.connect();
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
);
const directory = mkdtempSync(join(tmpdir(), "drevo-pg-runtime-"));
const source = join(directory, "source.sqlite"),
  uploads = join(directory, "uploads");
mkdirSync(uploads);
const family: Family = {
  title: "Изолированная проверка",
  description: "",
  demo: false,
  photos: [],
  links: [],
  people: [
    {
      id: "person-a",
      surname: "Тестов",
      name: "Иван",
      patronymic: "",
      sex: "m",
      birth: "1990",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      generation: 1,
      column: 0,
      createdBy: "owner",
    },
  ],
};
let live: Awaited<ReturnType<typeof openArchive>> | undefined;
let app: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  delete process.env.DATABASE_BACKEND;
  const sqlite = await openArchive(source, family);
  const users = await userStore(sqlite.db, { initialAdminId: "owner" });
  await users.register("owner", "Владелец");
  await users.register("vk:42", "Участник VK");
  await users.setRole((await users.get("owner"))!, "vk:42", "researcher");
  await settingsStore(sqlite.db);
  await aiSettingsStore(sqlite.db);
  const before = await sqlite.read();
  await sqlite.close();
  const imported = await importSqliteSnapshot(
    source,
    uploads,
    "runtime-test",
    client,
    "owner",
  );
  console.log(
    "runtime_import",
    imported.counts.people,
    Object.keys(imported.services).length,
  );
  process.env.DATABASE_BACKEND = "postgres";
  process.env.ARCHIVE_ID = "runtime-test";
  // Simulate the deployed schema before the additive VK extension.
  await client.query("DROP TABLE vk_auth_settings");
  await client.query("ALTER TABLE ai_settings DROP COLUMN role_profiles");
  await client.query("ALTER TABLE documents DROP COLUMN annotations");
  live = await openArchive(source, family);
  assert.equal(live.db.kind, "postgres");
  assert.equal(
    (
      await live.db
        .prepare("", "SELECT 1 AS allowed FROM platform_admins WHERE account_id=?")
        .get("owner")
    )?.allowed,
    1,
  );
  assert.equal(
    await live.db
      .prepare("", "SELECT 1 AS allowed FROM platform_admins WHERE account_id=?")
      .get("vk:42"),
    undefined,
  );
  assert.deepEqual(await live.read(), before);
  await live.db
    .prepare("", "INSERT INTO media_originals(url,size_bytes) VALUES(?,?)")
    .run("/media/original.png", 123);
  assert.equal(
    (await live.db.prepare("", "SELECT size_bytes FROM media_originals").get())
      ?.size_bytes,
    123,
  );
  await client.query(
    "SELECT set_config('drevo.archive_id','runtime-test',false)",
  );
  assert.equal(
    (
      await client.query(
        "SELECT subject FROM account_identities WHERE account_id='vk:42' AND provider='vk'",
      )
    ).rows[0]?.subject,
    "42",
  );
  // A second archive has the same local person ID. Even the table owner must
  // see only the archive selected by its connection, including import shadows.
  await client.query(
    "SELECT set_config('drevo.archive_id','other-archive',false)",
  );
  await client.query(
    "INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version) VALUES('other-archive','Other','',false,0,18)",
  );
  await client.query("INSERT INTO people(id,data) VALUES('person-a',$1)", [
    JSON.stringify({ ...family.people[0], name: "Чужой" }),
  ]);
  const other = await openPostgresDatabase("other-archive", source);
  try {
    assert.equal(
      (await other.prepare("", "SELECT count(*) AS n FROM people").get())?.n,
      1,
    );
    assert.equal(
      (
        await other
          .prepare("", "SELECT count(*) AS n FROM media_originals")
          .get()
      )?.n,
      0,
    );
    await assert.rejects(
      other
        .prepare(
          "",
          "INSERT INTO media_originals(archive_id,url,size_bytes) VALUES('runtime-test','/media/forbidden.png',1)",
        )
        .run(),
      /row-level security/,
    );
    assert.equal(
      (
        await other
          .prepare("", "SELECT count(*) AS n FROM service_snapshot_rows")
          .get()
      )?.n,
      0,
    );
    assert.equal(
      (await live.db.prepare("", "SELECT count(*) AS n FROM archives").get())
        ?.n,
      1,
    );
    await assert.rejects(
      live.db
        .prepare(
          "",
          "INSERT INTO people(archive_id,id,data) VALUES('other-archive','forbidden','{}')",
        )
        .run(),
      /row-level security/,
    );
    assert.equal((await live.read()).family.people[0].name, "Иван");
  } finally {
    await other.close();
  }
  await client.query(
    "SELECT set_config('drevo.archive_id','runtime-test',false)",
  );
  const runtimeUsers = await userStore(live.db);
  assert.equal((await runtimeUsers.get("owner"))?.role, "admin");
  assert.equal((await runtimeUsers.get("vk:42"))?.role, "researcher");
  assert.deepEqual(await accountCapacity(live.db, "vk:42"), {
    available: true,
    owned: false,
  });
  assert.deepEqual(await accountCapacity(live.db, "owner"), {
    available: true,
    owned: true,
    fullAccess: true,
    people: 1,
    peopleLimit: 150,
    mediaBytes: 0,
    mediaLimitBytes: 500_000_000,
  });
  await runtimeUsers.register("reader", "Читатель");
  const owner = (await runtimeUsers.get("owner"))!;
  const aiSettings = await aiSettingsStore(live.db);
  const commonAi = await aiSettings.read();
  await aiSettings.write(
    {
      ...commonAi,
      roleProfiles: {
        ...commonAi.roleProfiles,
        researcher: {
          ...defaultAiRoleProfile(commonAi),
          model: "gpt://test/researcher",
          pdfEnabled: false,
        },
      },
    },
    owner,
  );
  assert.equal(
    (await aiRuntimeConfig(aiSettings, "researcher")).modelUri,
    "gpt://test/researcher",
  );
  await runtimeUsers.setRole(owner, "reader", "reader");
  assert.equal((await runtimeUsers.list()).length, 3);
  assert.equal((await runtimeUsers.get("reader"))?.fullAccess, false);
  await assert.rejects(
    runtimeUsers.setFullAccess((await runtimeUsers.get("vk:42"))!, "reader", true),
    /администратор платформы/,
  );
  assert.equal((await runtimeUsers.get("reader"))?.fullAccess, false);
  assert.equal((await runtimeUsers.setFullAccess(owner, "reader", true)).fullAccess, true);
  assert.equal((await runtimeUsers.listPage(20)).users.find((user) => user.id === "reader")?.fullAccess, true);
  await runtimeUsers.setFullAccess(owner, "reader", false);
  await assert.rejects(
    runtimeUsers.remove({ ...owner, id: "local" }, "owner"),
    /владельца/,
  );
  const preferences = treePreferencesStore(live.db);
  const vkSettings = vkAuthSettingsStore(live.db, "https://archive.invalid");
  assert.equal((await vkSettings.read()).available, false);
  await vkSettings.write({ enabled: true, clientId: "12345" }, owner);
  assert.equal((await vkSettings.read()).available, true);
  const isolatedVk = await openPostgresDatabase("other-archive", source);
  try {
    const isolatedAi = await aiSettingsStore(isolatedVk);
    assert.equal((await isolatedAi.read()).roleProfiles.researcher, null);
    await assert.rejects(
      isolatedVk
        .prepare(
          "",
          "INSERT INTO ai_settings(archive_id,id) VALUES('runtime-test',1)",
        )
        .run(),
      /row-level security/,
    );
    assert.equal(
      (await vkAuthSettingsStore(isolatedVk, "https://archive.invalid").read())
        .available,
      false,
    );
    await assert.rejects(
      isolatedVk
        .prepare(
          "",
          "INSERT INTO vk_auth_settings(archive_id,id,enabled,client_id) VALUES('runtime-test',1,1,'1')",
        )
        .run(),
      /row-level security/,
    );
  } finally {
    await isolatedVk.close();
  }
  await preferences.write("owner", {
    reverseTimeline: false,
    cardVariant: "portrait",
    colorScheme: "white",
  });
  assert.equal((await preferences.read("owner")).colorScheme, "white");
  const chats = aiChatStore(live.db);
  const chat = await chats.create("owner", "all");
  await chats.append(chat.id, "user", "Проверка");
  assert.equal((await chats.list("owner", "all"))[0].title, "Проверка");
  const [lease1, lease2] = await Promise.all([
    chats.acquire(chat.id),
    chats.acquire(chat.id),
  ]);
  assert.equal([lease1, lease2].filter(Boolean).length, 1);
  await chats.release(chat.id, (lease1 || lease2)!);
  const usage = aiUsageStore(live.db),
    turn = await usage.begin("owner", "test-model");
  await usage.finish(turn.id, turn.started, {
    status: "ok",
    providerCalls: 1,
    inputTokens: 12,
    outputTokens: 3,
  });
  assert.equal((await usage.summary()).today.totalTokens, 15);
  const result = await live.write(
    { ...family, description: "PostgreSQL" },
    before.revision,
    owner,
  );
  assert.equal(result.revision, before.revision + 1);
  await assert.rejects(
    live.write(family, before.revision, owner),
    /другой вкладке/,
  );
  const snapshot = await live.read();
  await runtimeUsers.setRole(owner, "vk:42", "relative");
  const staleActor = (await runtimeUsers.get("vk:42"))!;
  await client.query("BEGIN");
  await client.query(
    "SELECT id FROM archives WHERE id='runtime-test' FOR UPDATE",
  );
  const delayedWrite = assert.rejects(
    live.write(snapshot.family, snapshot.revision, staleActor),
    /Права доступа изменились/,
  );
  await client.query(
    "UPDATE archive_memberships SET role='reader' WHERE user_id='vk:42'",
  );
  await client.query("COMMIT");
  await delayedWrite;
  const second = await openArchive(source, family);
  const results = await Promise.allSettled([
    second.write(
      { ...snapshot.family, description: "A" },
      snapshot.revision,
      owner,
    ),
    live.write(
      { ...snapshot.family, description: "B" },
      snapshot.revision,
      owner,
    ),
  ]);
  await second.close();
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  await assert.rejects(
    live.db.transaction(async () => {
      await live!.db
        .prepare("", "UPDATE archives SET description='rollback'")
        .run();
      assert.equal((await live!.read()).family.description, "rollback");
      throw new Error("Intentional rollback");
    }),
    /Intentional rollback/,
  );
  assert.notEqual((await live.read()).family.description, "rollback");
  await assert.rejects(
    live.write(
      family,
      snapshot.revision + 1,
      (await runtimeUsers.get("reader"))!,
    ),
    /просмотр|измен|прав|доступ/i,
  );
  const portable = join(directory, "portable.sqlite");
  await writeDatabaseBackup(live.db, portable);
  await live.close();
  live = undefined;
  delete process.env.DATABASE_BACKEND;
  const restored = await openArchive(portable, family);
  assert.equal(
    (await vkAuthSettingsStore(restored.db, "https://archive.invalid").read())
      .clientId,
    "12345",
  );
  assert.equal((await restored.read()).revision, snapshot.revision + 1);
  assert.equal(
    (await aiChatStore(restored.db).messages(chat.id, "owner"))?.length,
    1,
  );
  await restored.close();
  process.env.DATABASE_BACKEND = "postgres";
  app = await startServer(0, source, true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  for (const path of [
    "/api/health",
    "/api/session",
    "/api/account/capacity",
    "/api/family",
    "/api/ai/chats",
    "/api/documents?limit=20",
    "/api/backups",
    "/api/settings",
    "/api/users?limit=20",
    "/api/audit",
    "/api/shares",
    "/api/admin/ai",
    "/api/admin/research-resources",
    "/api/mcp/tokens",
    "/api/tree-preferences",
    "/api/people/search?q=Иван",
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, `${path}: ${await response.text()}`);
  }
  const runtimeHttpUsers = await userStore(app.archive.db);
  const tierChange = await fetch(base + "/api/users/reader", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullAccess: true }),
  });
  assert.equal(tierChange.status, 200, await tierChange.clone().text());
  assert.equal((await tierChange.json()).user.fullAccess, true);
  assert.equal((await runtimeHttpUsers.get("reader"))?.fullAccess, true);
  const mixedTierChange = await fetch(base + "/api/users/reader", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullAccess: false, role: "admin" }),
  });
  assert.equal(mixedTierChange.status, 400);
  assert.equal((await runtimeHttpUsers.get("reader"))?.fullAccess, true);
  await runtimeHttpUsers.setFullAccess(
    (await runtimeHttpUsers.get("owner"))!,
    "reader",
    false,
  );
  // A page must retain the revision from its REPEATABLE READ snapshot even
  // when another connection commits between checking the token and reading rows.
  const concurrent = await openArchive(source, family);
  const pageBefore = await app.archive.read();
  const overview = await fetch(base + "/api/family?projection=overview").then(
    (r) => r.json(),
  );
  const peoplePage = app.archive.peoplePage;
  let intervened = false;
  app.archive.peoplePage = async (offset, limit) => {
    if (!intervened) {
      intervened = true;
      const changed = structuredClone(pageBefore.family);
      changed.people[0].biography = "Committed while the page was loading";
      await concurrent.write(changed, pageBefore.revision, owner);
    }
    return await peoplePage(offset, limit);
  };
  try {
    const path =
      base +
      "/api/family?projection=page&collection=people&offset=0&token=" +
      encodeURIComponent(overview.pageToken);
    const response = await fetch(path);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(
      page.items[0].biography,
      pageBefore.family.people[0].biography,
    );
    assert.equal(page.pageToken, overview.pageToken);
    assert.equal((await fetch(path)).status, 409);
    assert.equal(
      (await app.archive.read()).family.people[0].biography,
      "Committed while the page was loading",
    );
  } finally {
    app.archive.peoplePage = peoplePage;
    await concurrent.close();
  }
  const pdf = new PDFDocument();
  const chunks: Buffer[] = [];
  const pdfReady = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", (block) => chunks.push(block));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  pdf.text("Isolated PostgreSQL document");
  pdf.end();
  const pdfBytes = await pdfReady;
  const uploaded = await fetch(base + "/api/documents", {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title: "Семейная запись", personIds: ["person-a"] }),
      ),
    },
    body: new Uint8Array(pdfBytes),
  });
  assert.equal(uploaded.status, 201, await uploaded.text());
  const documents = await fetch(
    base + "/api/documents?q=" + encodeURIComponent("семейная"),
  ).then((r) => r.json());
  assert.equal(documents.total, 1);
  const annotationUrl = `${base}/api/documents/${documents.items[0].id}/annotations`;
  const annotated = await fetch(annotationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.3,
      height: 0.2,
      text: "Важная запись",
    }),
  });
  assert.equal(annotated.status, 201, await annotated.clone().text());
  const fileResponse = await fetch(base + documents.items[0].url);
  assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), pdfBytes);
  const fullBackup = await fetch(base + "/api/backup/full");
  assert.equal(fullBackup.status, 200);
  const backupBytes = await fullBackup.arrayBuffer();
  const preview = await fetch(base + "/api/restore/preview", {
    method: "POST",
    headers: { "X-Drevo-Restore": "1" },
    body: backupBytes,
  });
  assert.equal(preview.status, 200);
  const previewData = await preview.json();
  assert.equal(previewData.documents, 1);
  const restore = await fetch(base + "/api/restore/apply", {
    method: "POST",
    headers: { "X-Drevo-Restore": "1" },
    body: JSON.stringify({ token: previewData.token, confirm: true }),
  });
  assert.equal(restore.status, 200, await restore.text());
  assert.equal(
    (await (await aiSettingsStore(app.archive.db)).read()).roleProfiles
      .researcher?.pdfEnabled,
    false,
  );
  const afterDocuments = await fetch(base + "/api/documents").then((r) =>
    r.json(),
  );
  assert.equal(afterDocuments.total, 1);
  const restoredAnnotations = await fetch(
    `${base}/api/documents/${afterDocuments.items[0].id}/annotations`,
  ).then((r) => r.json());
  assert.equal(restoredAnnotations.items[0].text, "Важная запись");
  assert.deepEqual(
    Buffer.from(
      await (await fetch(base + afterDocuments.items[0].url)).arrayBuffer(),
    ),
    pdfBytes,
  );
  const documentId = afterDocuments.items[0].id;
  const deleted = await Promise.all(
    [0, 1].map(() =>
      fetch(base + "/api/documents/" + documentId, { method: "DELETE" }),
    ),
  );
  assert.deepEqual(
    deleted.map((response) => response.status).sort(),
    [200, 404],
  );
  assert.equal(
    Number(
      (await app.archive.db
        .prepare(
          "SELECT count(*) AS n FROM audit_entries WHERE entity='document' AND entity_id=? AND action='Удалён документ'",
          "SELECT count(*) AS n FROM archive_audit_entries WHERE entity='document' AND entity_id=? AND action='Удалён документ'",
        )
        .get(documentId))!.n,
    ),
    1,
  );
  assert.equal(
    (await fetch(base + "/api/documents").then((r) => r.json())).total,
    0,
  );
  const unlinkedUpload = await fetch(base + "/api/documents", {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title: "Документ без привязки", personIds: [] }),
      ),
    },
    body: new Uint8Array(pdfBytes),
  });
  assert.equal(unlinkedUpload.status, 201, await unlinkedUpload.clone().text());
  const unlinkedId = (await unlinkedUpload.json()).id;
  assert.deepEqual(
    (await fetch(base + `/api/documents/${unlinkedId}`).then((r) => r.json()))
      .people,
    [],
  );
  assert.equal(
    (await fetch(base + `/api/documents/${unlinkedId}`, { method: "DELETE" }))
      .status,
    200,
  );
  await app.close();
  app = undefined;
  // Production-style authentication and persisted sessions across restart.
  process.env.PUBLIC_ORIGIN = "https://migration-check.invalid";
  process.env.INITIAL_ADMIN_YANDEX_ID = "owner";
  app = await startServer(0, source, true);
  const securedBase = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const token = newSessionToken();
  await app.archive.db
    .prepare(
      "",
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'reader',?)",
    )
    .run(sessionTokenHash(token), Date.now() + 60000);
  const headers = {
    Cookie: `drevo_session=${token}`,
    Origin: process.env.PUBLIC_ORIGIN,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await fetch(securedBase + "/api/session", { headers }).then((r) =>
        r.json(),
      )
    ).user.id,
    "reader",
  );
  assert.equal(await accountAiAccess(app.archive.db, "reader"), false);
  assert.equal(
    (await fetch(securedBase + "/api/ai/status", { headers }).then((r) =>
      r.json(),
    )).enabled,
    false,
  );
  assert.equal(
    (await fetch(securedBase + "/api/ai/chats", { headers })).status,
    403,
  );
  const aiOwnerToken = newSessionToken();
  await app.archive.db
    .prepare(
      "",
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'owner',?)",
    )
    .run(sessionTokenHash(aiOwnerToken), Date.now() + 60000);
  const ownerHeaders = {
    ...headers,
    Cookie: `drevo_session=${aiOwnerToken}`,
  };
  assert.equal(await accountAiAccess(app.archive.db, "vk:42"), true);
  assert.equal(
    (await fetch(securedBase + "/api/faces/status", { headers: ownerHeaders })
      .then((r) => r.json())).enabled,
    true,
  );
  const boundToken = await mcpTokenStore(app.archive.db).issue(owner, {
    name: "Проверка уровня",
    scopes: ["tree:read"],
    boundUserId: "vk:42",
  });
  await app.archive.db
    .prepare("", "UPDATE account_tiers SET full_access=false WHERE account_id=?")
    .run("vk:42");
  assert.equal(await accountAiAccess(app.archive.db, "vk:42"), false);
  assert.equal(
    (await fetch(securedBase + "/mcp", {
      method: "POST",
      headers: {
        Origin: process.env.PUBLIC_ORIGIN,
        Authorization: `Bearer ${boundToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })).status,
    403,
  );
  await app.archive.db
    .prepare("", "UPDATE account_tiers SET full_access=true WHERE account_id=?")
    .run("vk:42");
  await app.archive.db
    .prepare("", "UPDATE account_tiers SET full_access=false WHERE account_id=?")
    .run("owner");
  assert.equal(
    (await fetch(securedBase + "/api/faces/status", { headers: ownerHeaders })
      .then((r) => r.json())).enabled,
    false,
  );
  assert.equal(
    (await fetch(securedBase + "/api/faces/match", {
      method: "POST",
      headers: ownerHeaders,
      body: "{}",
    })).status,
    403,
  );
  assert.equal(
    (await fetch(securedBase + "/api/ai/chats", { headers: ownerHeaders }))
      .status,
    403,
  );
  assert.equal(
    (await fetch(securedBase + "/api/admin/ai", { headers: ownerHeaders }))
      .status,
    403,
  );
  assert.equal(
    (await fetch(securedBase + "/api/mcp/tokens", { headers: ownerHeaders }))
      .status,
    403,
  );
  assert.equal(
    (await fetch(securedBase + "/api/research/suggestions", {
      headers: ownerHeaders,
    })).status,
    403,
  );
  assert.equal(
    (await fetch(securedBase + "/mcp", {
      method: "POST",
      headers: {
        Origin: process.env.PUBLIC_ORIGIN,
        Authorization: `Bearer ${boundToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })).status,
    403,
  );
  await app.archive.db
    .prepare("", "UPDATE account_tiers SET full_access=true WHERE account_id=?")
    .run("owner");
  assert.equal(
    (await fetch(securedBase + "/api/admin/ai", { headers })).status,
    403,
  );
  assert.equal(
    (
      await fetch(securedBase + "/api/family", {
        method: "PUT",
        headers,
        body: JSON.stringify(family),
      })
    ).status,
    403,
  );
  const archiveAdminToken = newSessionToken();
  await app.archive.db
    .prepare(
      "",
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'vk:42',?)",
    )
    .run(sessionTokenHash(archiveAdminToken), Date.now() + 60_000);
  await app.archive.db
    .prepare("", "UPDATE archive_memberships SET role='admin' WHERE user_id='vk:42'")
    .run();
  const archiveAdminHeaders = {
    ...headers,
    Cookie: `drevo_session=${archiveAdminToken}`,
  };
  const archiveAdminSession = await fetch(securedBase + "/api/session", {
    headers: archiveAdminHeaders,
  }).then((response) => response.json());
  assert.equal(archiveAdminSession.user.role, "admin");
  assert.equal(archiveAdminSession.user.platformAdmin, false);
  assert.equal(
    (await fetch(securedBase + "/api/family?projection=overview", {
      headers: archiveAdminHeaders,
    }).then((response) => response.json())).user.platformAdmin,
    false,
  );
  for (const path of ["/api/backups", "/api/backup/full"]) {
    assert.equal(
      (await fetch(securedBase + path, { headers: archiveAdminHeaders })).status,
      403,
    );
  }
  assert.equal(
    (await fetch(securedBase + "/api/restore/preview", {
      method: "POST",
      headers: { ...archiveAdminHeaders, "x-drevo-restore": "1" },
      body: "invalid backup",
    })).status,
    403,
  );
  await app.archive.db
    .prepare("", "UPDATE archive_memberships SET role='reader' WHERE user_id='vk:42'")
    .run();
  const manager = await backupCoordinator(app.archive.db, source, {
    schedule: false,
  });
  try {
    await manager.startCreate(owner);
    await manager.idle();
    const status = await manager.status(owner.id);
    assert.equal(status.job?.state, "succeeded", JSON.stringify(status.job));
  } finally {
    await manager.close();
  }
  await client.query(
    "UPDATE account_tiers SET full_access=false WHERE account_id='owner'",
  );
  const quotaDb = app.archive.db;
  await quotaDb.transaction(async () => {
    await quotaDb
      .prepare(
        "",
        "INSERT INTO media_originals(url,size_bytes) VALUES('/media/quota.png',?)",
      )
      .run(BASIC_MEDIA_BYTES - 1);
    await quotaDb
      .prepare(
        "",
        "INSERT INTO media_upload_grants(url,user_id,expires_ms) VALUES('/media/quota.png','owner',?)",
      )
      .run(Date.now() + 60_000);
    await enforcePostgresMediaQuota(quotaDb);
  });
  const ownerToken = newSessionToken();
  await quotaDb
    .prepare(
      "",
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'owner',?)",
    )
    .run(sessionTokenHash(ownerToken), Date.now() + 60_000);
  assert.equal(
    (await fetch(securedBase + "/api/backups", {
      headers: { Cookie: `drevo_session=${ownerToken}` },
    })).status,
    200,
  );
  assert.equal(
    (await fetch(securedBase + "/api/family?projection=overview", {
      headers: { Cookie: `drevo_session=${ownerToken}` },
    }).then((response) => response.json())).user.platformAdmin,
    true,
  );
  const rejectedPdf = await fetch(securedBase + "/api/documents", {
    method: "POST",
    headers: {
      Cookie: `drevo_session=${ownerToken}`,
      Origin: process.env.PUBLIC_ORIGIN,
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title: "Сверх лимита", personIds: ["person-a"] }),
      ),
    },
    body: new Uint8Array(pdfBytes),
  });
  assert.equal(rejectedPdf.status, 507, await rejectedPdf.text());
  assert.equal(
    (await quotaDb.prepare("", "SELECT count(*) AS n FROM documents").get())?.n,
    0,
  );
  const attempts = await Promise.allSettled(
    ["quota-one", "quota-two"].map((id) =>
      quotaDb.transaction(async () => {
        await quotaDb
          .prepare(
            "",
            "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,1,'owner',?)",
          )
          .run(id, id, id, `${id}.pdf`, new Date().toISOString());
        await enforcePostgresMediaQuota(quotaDb);
      }),
    ),
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "rejected").length,
    1,
  );
  assert.ok(
    attempts.some(
      (attempt) =>
        attempt.status === "rejected" &&
        attempt.reason instanceof UploadQuotaError,
    ),
  );
  assert.equal(
    (await quotaDb.prepare("", "SELECT count(*) AS n FROM documents").get())?.n,
    1,
  );
  await quotaDb.transaction(async () => {
    await quotaDb
      .prepare("", "INSERT INTO photos(id,data) VALUES('quota-photo',?::jsonb)")
      .run(JSON.stringify({ url: "/media/quota.png", title: "", tags: [] }));
    await releaseAttachedMediaGrants(quotaDb);
    assert.equal(
      (
        await quotaDb
          .prepare("", "SELECT count(*) AS n FROM media_upload_grants")
          .get()
      )?.n,
      0,
    );
    await quotaDb.exec("", "DELETE FROM photos WHERE id='quota-photo'");
    await enforcePostgresMediaQuota(quotaDb);
  });
  await quotaDb.transaction(async () => {
    await quotaDb.exec("", "DELETE FROM documents WHERE id LIKE 'quota-%'");
    await quotaDb.exec(
      "",
      "DELETE FROM media_originals WHERE url='/media/quota.png'",
    );
  });
  await assert.rejects(
    quotaDb.transaction(async () => {
      await quotaDb
        .prepare(
          "",
          "INSERT INTO photos(id,data) VALUES('foreign-photo',?::jsonb)",
        )
        .run(
          JSON.stringify({ url: "/media/foreign.png", title: "", tags: [] }),
        );
      await enforcePostgresMediaQuota(quotaDb);
    }),
    (error) => error instanceof UploadQuotaError,
  );
  assert.equal(
    (
      await quotaDb
        .prepare(
          "",
          "SELECT count(*) AS n FROM photos WHERE id='foreign-photo'",
        )
        .get()
    )?.n,
    0,
  );
  await client.query(
    "UPDATE account_tiers SET full_access=true WHERE account_id='owner'",
  );
  console.log("runtime_http_and_backup_ok");
} finally {
  await app?.close();
  await live?.close();
  await client.end();
  rmSync(directory, { recursive: true, force: true });
}
