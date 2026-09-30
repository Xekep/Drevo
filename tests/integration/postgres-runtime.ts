import { readStorageLimits, writeStorageLimits, enforceUserStorageLimit } from "../../src/server/storage-limits.ts";
import { DEFAULT_STORAGE_LIMITS } from "../../src/shared/storage-limits.ts";
import assert from "node:assert/strict";
import { vkAuthSettingsStore } from "../../src/server/vk-auth-settings.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { aiChatStore, AiChatLimitError } from "../../src/server/ai-chats.ts";
import { aiUsageStore } from "../../src/server/ai-usage.ts";
import { accountAiAccess } from "../../src/server/account-ai-access.ts";
import { accountCapacity } from "../../src/server/account-capacity.ts";
import { mcpTokenStore } from "../../src/server/mcp-tokens.ts";
import { treePreferencesStore } from "../../src/server/tree-preferences.ts";
import { publishedPeopleStore } from "../../src/server/published-people.ts";
import { accountArchiveDirectory } from "../../src/server/account-archives.ts";
import { completePostgresOAuthLoginInTransaction } from "../../src/server/postgres-yandex-login.ts";
import { importSqliteSnapshot } from "../../ops/postgres/import-sqlite.ts";
import { writeDatabaseBackup } from "../../src/server/backup.ts";
import { startServer } from "../../src/server/index.ts";
import { adaptLegacyAiFake } from "../legacy-ai-fake.ts";
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
let otherApp: Awaited<ReturnType<typeof startServer>> | undefined;
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
    const primaryPublished = publishedPeopleStore(live.db);
    const otherPublished = publishedPeopleStore(other);
    await primaryPublished.publish("person-a", "owner");
    assert.equal(Boolean(await primaryPublished.getFields("person-a")), true);
    assert.equal((await primaryPublished.entries()).has("person-a"), true);
    assert.equal(Boolean(await otherPublished.getFields("person-a")), false);
    await otherPublished.publish("person-a", "owner");
    assert.equal((await otherPublished.entries()).has("person-a"), true);
    await primaryPublished.unpublish("person-a");
    assert.equal(Boolean(await primaryPublished.getFields("person-a")), false);
    assert.equal(Boolean(await otherPublished.getFields("person-a")), true);
    await otherPublished.unpublish("person-a");
    // Explicit archive selection keeps same-ID people in separate snapshots.
    const otherArchive = await openArchive(source, family, "other-archive");
    try {
      const [firstSnapshot, secondSnapshot] = await Promise.all([
        live.read(),
        otherArchive.read(),
      ]);
      assert.equal(firstSnapshot.family.people[0].name, "Иван");
      assert.equal(secondSnapshot.family.people[0].name, "Чужой");
      assert.equal(otherArchive.db.archiveId, "other-archive");
      assert.equal(live.db.archiveId, "runtime-test");
      const changed = structuredClone(secondSnapshot.family);
      changed.people[0].name = "Исправленный сосед";
      await otherArchive.write(changed, secondSnapshot.revision);
      assert.equal(
        (await otherArchive.read()).family.people[0].name,
        "Исправленный сосед",
      );
      assert.equal((await live.read()).family.people[0].name, "Иван");
    } finally {
      await otherArchive.close();
    }
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
  await live.db.transaction(() => writeStorageLimits(live!.db, { ...DEFAULT_STORAGE_LIMITS, admin: 0 }, owner));
  assert.equal((await readStorageLimits(live.db)).admin, 0);
  await assert.rejects(enforceUserStorageLimit(live.db, "owner", 1), UploadQuotaError);
  const vkSettings = vkAuthSettingsStore(live.db, "https://archive.invalid");
  assert.equal((await vkSettings.read()).available, false);
  await vkSettings.write({ enabled: true, clientId: "12345" }, owner);
  assert.equal((await vkSettings.read()).available, true);
  const isolatedVk = await openPostgresDatabase("other-archive", source);
  try {
    assert.deepEqual(await readStorageLimits(isolatedVk), DEFAULT_STORAGE_LIMITS);
    await assert.rejects(isolatedVk.prepare("", "INSERT INTO upload_limits(archive_id,id,data) VALUES('runtime-test',1,'{}')").run(), /row-level security/);
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
  await live.db.transaction(() => writeStorageLimits(live!.db, DEFAULT_STORAGE_LIMITS, owner));
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
  const chatAttempts = await Promise.allSettled(
    Array.from({ length: 10 }, () => chats.create("owner", "all")),
  );
  const createdChats = chatAttempts.filter(
    (item) => item.status === "fulfilled",
  );
  assert.equal(
    createdChats.length,
    9,
    "concurrent PostgreSQL requests cannot exceed ten chats",
  );
  const rejectedChat = chatAttempts.find(
    (item) => item.status === "rejected",
  ) as PromiseRejectedResult;
  assert.ok(rejectedChat.reason instanceof AiChatLimitError);
  for (const item of createdChats) await chats.delete(item.value.id, "owner");
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
        JSON.stringify({
          title: "Семейная запись",
          personIds: ["person-a"],
          documentType: "metrical record",
          documentDate: "1887",
          place: "Rezh",
          description: "Register page 12",
          provenance: "GASO F6 Op13 D104",
        }),
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
  assert.equal(afterDocuments.items[0].documentType, "metrical record");
  assert.equal(afterDocuments.items[0].provenance, "GASO F6 Op13 D104");
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
        JSON.stringify({
          title: "Документ без привязки",
          personIds: [],
          documentType: "metrical record",
          documentDate: "1887",
          place: "Rezh",
          description: "Register page 12",
          provenance: "GASO F6 Op13 D104",
        }),
      ),
    },
    body: new Uint8Array(pdfBytes),
  });
  assert.equal(unlinkedUpload.status, 201, await unlinkedUpload.clone().text());
  const unlinkedId = (await unlinkedUpload.json()).id;
  const unlinkedDocument = await fetch(base + `/api/documents/${unlinkedId}`).then((r) => r.json());
  assert.deepEqual(unlinkedDocument.people, []);
  assert.equal(unlinkedDocument.provenance, "GASO F6 Op13 D104");
  assert.equal(unlinkedDocument.documentDate, "1887");
  const expectedDetails = {
    title: unlinkedDocument.title,
    documentType: unlinkedDocument.documentType,
    documentDate: unlinkedDocument.documentDate,
    place: unlinkedDocument.place,
    description: unlinkedDocument.description,
    provenance: unlinkedDocument.provenance,
  };
  const updatedDetails = { ...expectedDetails, provenance: "GASO F6 Op13 D105" };
  const updateDocument = () => fetch(base + `/api/documents/${unlinkedId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected: expectedDetails, next: updatedDetails }),
  });
  assert.equal((await updateDocument()).status, 200);
  assert.equal((await updateDocument()).status, 409);
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
  let releaseAiProvider: (() => void) | undefined;
  let notifyAiProvider: (() => void) | undefined;
  const aiProviderStarted = new Promise<void>((resolve) => { notifyAiProvider = resolve; });
  const aiProviderGate = new Promise<void>((resolve) => { releaseAiProvider = resolve; });
  app = await startServer(0, source, true, undefined, adaptLegacyAiFake(async () => {
    notifyAiProvider?.();
    await aiProviderGate;
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Недоступный ответ" } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }));
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
  const aiKeys = ["YANDEX_AI_API_KEY", "YANDEX_AI_FOLDER_ID", "YANDEX_AI_MODEL"] as const;
  const previousAiEnvironment = aiKeys.map((key) => process.env[key]);
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  try {
    const startedAnswer = await fetch(securedBase + "/api/ai/chat/stream", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ message: "Расскажи о родословной" }),
    });
    assert.equal(startedAnswer.status, 200);
    await Promise.race([
      aiProviderStarted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI provider did not start")), 15_000)),
    ]);
    await app.archive.db
      .prepare("", "UPDATE account_tiers SET full_access=false WHERE account_id=?")
      .run("owner");
    releaseAiProvider?.();
    const frames = await startedAnswer.text();
    assert.match(frames, /event: error/);
    assert.match(frames, /Доступ к ИИ отключён/);
    assert.doesNotMatch(frames, /event: done|Недоступный ответ/);
    assert.equal(
      (await app.archive.db.prepare("", "SELECT count(*)::int AS count FROM ai_chat_messages WHERE content=?").get("Недоступный ответ"))?.count,
      0,
    );
    await app.archive.db
      .prepare("", "UPDATE account_tiers SET full_access=true WHERE account_id=?")
      .run("owner");
  } finally {
    releaseAiProvider?.();
    aiKeys.forEach((key, index) => {
      const value = previousAiEnvironment[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
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
  // The same media URL must resolve inside the selected archive's storage root.
  await client.query(
    "SELECT set_config('drevo.archive_id','other-archive',false)",
  );
  await client.query(
    "INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES('other-archive','owner','admin',true,'all')",
  );
  await client.query(
    "SELECT set_config('drevo.archive_id','runtime-test',false)",
  );
  otherApp = await startServer(0, source, true, undefined, undefined, "other-archive");
  const otherBase = `http://127.0.0.1:${(otherApp.server.address() as { port: number }).port}`;
  assert.equal(otherApp.archive.db.archiveId, "other-archive");
  assert.equal(
    (await fetch(securedBase + "/a/other-archive/api/session", { headers })).status,
    404,
  );
  assert.equal(
    (await fetch(securedBase + "/a/other-archive/api/session", { headers: ownerHeaders })
      .then((r) => r.json())).user.id,
    "owner",
  );
  const selectedFamily = await fetch(securedBase + "/a/other-archive/api/family", {
    headers: ownerHeaders,
  });
  assert.equal(selectedFamily.status, 200);
  const selectedSnapshot = await selectedFamily.json();
  assert.equal(selectedSnapshot.family.people[0].name, "Исправленный сосед");
  assert.equal(
    (await fetch(securedBase + "/a/other-archive/api/health", { headers })).status,
    404,
    "warming an archive must not expose even public routes to other members",
  );
  const selectedShareResponse = await fetch(securedBase + "/a/other-archive/api/shares", {
    method: "POST",
    headers: { ...ownerHeaders, "If-Match": String(selectedSnapshot.revision) },
    body: JSON.stringify({
      title: "Selected archive share",
      anchorId: "person-a",
      personIds: ["person-a"],
      durationHours: 1,
    }),
  });
  const selectedShare = await selectedShareResponse.json();
  assert.equal(selectedShareResponse.status, 201, JSON.stringify(selectedShare));
  assert.match(selectedShare.path, /^\/a\/other-archive\/s\/[A-Za-z0-9_-]{43}$/);
  const selectedShareToken = selectedShare.path.split("/").at(-1);
  const publicSelectedShare = await fetch(
    securedBase + `/a/other-archive/api/shared/${selectedShareToken}`,
  );
  const publicSelectedFamily = await publicSelectedShare.json();
  assert.equal(publicSelectedShare.status, 200, JSON.stringify(publicSelectedFamily));
  assert.equal(publicSelectedFamily.family.people[0].name, "Исправленный сосед");
  assert.equal(
    (await fetch(securedBase + `/a/runtime-test/api/shared/${selectedShareToken}`)).status,
    410,
    "a bearer token cannot open a different archive",
  );
  assert.equal(
    (await fetch(securedBase + `/api/shared/${selectedShareToken}`)).status,
    410,
    "a selected archive token cannot open the original archive",
  );
  assert.equal(
    (await fetch(securedBase + `/a/other-archive/api/shared/${selectedShareToken}`, {
      method: "POST",
    })).status,
    405,
  );
  assert.equal(
    (await fetch(securedBase + `/a/other-archive/api/shares/${selectedShare.share.id}`, {
      method: "DELETE",
      headers: ownerHeaders,
    })).status,
    200,
  );
  assert.equal(
    (await fetch(securedBase + `/a/other-archive/api/shared/${selectedShareToken}`)).status,
    410,
  );
  const invitationResponse = await fetch(securedBase + "/a/other-archive/api/invitations", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ role: "reader", durationHours: 24 }),
  });
  const invitation = await invitationResponse.json();
  assert.equal(invitationResponse.status, 201, JSON.stringify(invitation));
  assert.match(invitation.path, /^\/join\/other-archive\/[A-Za-z0-9_-]{43}$/);
  const inviteBody = JSON.stringify({
    archiveId: "other-archive",
    token: invitation.path.split("/").at(-1),
  });
  const invitationHeaders = {
    Origin: process.env.PUBLIC_ORIGIN!,
    "Content-Type": "application/json",
  };
  const previewInvitation = await fetch(securedBase + "/api/account/invitations/preview", {
    method: "POST",
    headers: invitationHeaders,
    body: inviteBody,
  });
  assert.equal(previewInvitation.status, 200);
  assert.equal((await previewInvitation.json()).role, "reader");
  assert.equal((await fetch(securedBase + "/api/account/invitations/accept", {
    method: "POST", headers: invitationHeaders, body: inviteBody,
  })).status, 401);
  await client.query(
    "INSERT INTO accounts(id,name,created_at) VALUES('invitee','Invitee',$1)",
    [new Date().toISOString()],
  );
  const inviteeToken = newSessionToken();
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'invitee',$2)",
    [sessionTokenHash(inviteeToken), Date.now() + 60_000],
  );
  const inviteeHeaders = {
    ...invitationHeaders,
    Cookie: `drevo_session=${inviteeToken}`,
  };
  const acceptedInvitation = await fetch(securedBase + "/api/account/invitations/accept", {
    method: "POST", headers: inviteeHeaders, body: inviteBody,
  });
  assert.equal(acceptedInvitation.status, 200, await acceptedInvitation.text());
  assert.equal(
    (await fetch(securedBase + "/a/other-archive/api/session", { headers: inviteeHeaders })
      .then((response) => response.json())).user.role,
    "reader",
  );
  assert.equal((await fetch(securedBase + "/api/account/invitations/accept", {
    method: "POST", headers: inviteeHeaders, body: inviteBody,
  })).status, 200, "the same account can retry a completed acceptance");
  assert.equal((await fetch(securedBase + "/api/account/invitations/accept", {
    method: "POST", headers: ownerHeaders, body: inviteBody,
  })).status, 410, "a one-use invitation cannot grant a second account");
  assert.equal((await fetch(securedBase + "/api/account/invitations/preview", {
    method: "POST",
    headers: invitationHeaders,
    body: JSON.stringify({ archiveId: "runtime-test", token: invitation.path.split("/").at(-1) }),
  })).status, 410, "the bearer cannot name a different archive");
  const revokedInviteResponse = await fetch(securedBase + "/a/other-archive/api/invitations", {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ role: "relative", durationHours: 24 }),
  });
  assert.equal(revokedInviteResponse.status, 201);
  const revokedInvite = await revokedInviteResponse.json();
  assert.equal((await fetch(securedBase + `/a/other-archive/api/invitations/${revokedInvite.id}`, {
    method: "DELETE", headers: ownerHeaders,
  })).status, 200);
  assert.equal((await fetch(securedBase + "/api/account/invitations/preview", {
    method: "POST", headers: invitationHeaders,
    body: JSON.stringify({ archiveId: "other-archive", token: revokedInvite.path.split("/").at(-1) }),
  })).status, 410);
  assert.equal(
    (await fetch(securedBase + "/a/other-archive/api/session", { headers })).status,
    404,
    "a nonmember cannot enter a selected archive after its runtime is warm",
  );
  assert.equal(
    (await fetch(securedBase + "/a/missing-archive/api/session", { headers: ownerHeaders })).status,
    404,
  );
  const ownerArchives = await fetch(securedBase + "/api/account/archives", {
    headers: ownerHeaders,
  }).then((r) => r.json());
  assert.equal(await accountArchiveDirectory(app.archive.db).contains("owner", "other-archive"), true);
  assert.equal(await accountArchiveDirectory(app.archive.db).contains("reader", "other-archive"), false);
  assert.deepEqual(
    new Set(ownerArchives.archives.map((archive: { id: string }) => archive.id)),
    new Set(["runtime-test", "other-archive"]),
  );
  assert.equal(
    ownerArchives.archives.find((archive: { id: string }) => archive.id === "runtime-test").current,
    true,
  );
  const readerArchives = await fetch(securedBase + "/api/account/archives", {
    headers,
  }).then((r) => r.json());
  assert.deepEqual(readerArchives.archives.map((archive: { id: string }) => archive.id), ["runtime-test"]);
  assert.equal((await fetch(securedBase + "/api/account/archives")).status, 401);
  assert.equal(
    (await fetch(otherBase + "/api/account/archives", { headers: ownerHeaders })
      .then((r) => r.json())).archives.find((archive: { id: string }) => archive.id === "other-archive").current,
    true,
  );
  await client.query(
    "INSERT INTO accounts(id,name,created_at) VALUES('other-only','Other only',$1)",
    [new Date().toISOString()],
  );
  await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
  await client.query(
    "INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES('other-archive','other-only','reader',true,'all')",
  );
  const otherOnlyToken = newSessionToken();
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'other-only',$2)",
    [sessionTokenHash(otherOnlyToken), Date.now() + 60_000],
  );
  const otherOnlyHeaders = { Cookie: `drevo_session=${otherOnlyToken}` };
  assert.equal(
    (await fetch(securedBase + "/a/other-archive/api/health", { headers: otherOnlyHeaders })).status,
    200,
  );
  const selectedUsers = await userStore(otherApp.archive.db);
  await selectedUsers.setApproved((await selectedUsers.get("owner"))!, "other-only", false);
  assert.equal(
    (await fetch(securedBase + "/a/other-archive/api/health", { headers: otherOnlyHeaders })).status,
    404,
    "unapproving a member must close an already warm selected archive",
  );
  assert.equal(
    (await fetch(securedBase + "/api/account/sessions", { headers: otherOnlyHeaders })).status,
    200,
    "archive approval must not revoke the global account session",
  );
  await selectedUsers.setApproved((await selectedUsers.get("owner"))!, "other-only", true);
  assert.equal(
    (await fetch(securedBase + "/a/other-archive/api/health", { headers: otherOnlyHeaders })).status,
    200,
  );
  const otherOnlySession = await fetch(securedBase + "/api/session", {
    headers: otherOnlyHeaders,
  }).then((r) => r.json());
  assert.equal(otherOnlySession.user, null);
  assert.equal(otherOnlySession.account.id, "other-only");
  assert.equal(
    (await fetch(securedBase + "/api/account/sessions", { headers: otherOnlyHeaders })).status,
    200,
  );
  assert.deepEqual(
    (await fetch(securedBase + "/api/account/archives", { headers: otherOnlyHeaders })
      .then((r) => r.json())).archives.map((archive: { id: string }) => archive.id),
    ["other-archive"],
  );
  await client.query(
    "DELETE FROM archive_memberships WHERE archive_id='other-archive' AND user_id='other-only'",
  );
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  assert.equal(
    (await fetch(securedBase + "/a/other-archive/api/health", { headers: otherOnlyHeaders })).status,
    404,
    "a warmed runtime must stop serving a member immediately after removal",
  );
  assert.deepEqual(
    (await fetch(securedBase + "/api/account/archives", { headers: otherOnlyHeaders })
      .then((r) => r.json())).archives,
    [],
    "removing one membership must preserve the global account session",
  );
  assert.equal(
    (await fetch(securedBase + "/api/session", { headers: otherOnlyHeaders })
      .then((r) => r.json())).account.id,
    "other-only",
  );
  const primaryDb = app.archive.db;
  assert.equal(
    (await primaryDb.prepare("", "SELECT count(*) AS n FROM archives").get())?.n,
    1,
    "account context must not leak outside the listing transaction",
  );
  assert.deepEqual(
    (await accountArchiveDirectory(primaryDb).list("reader"))?.map((archive) => archive.id),
    ["runtime-test"],
  );
  await primaryDb.transaction(async () => {
    await primaryDb.prepare("", "SELECT set_config('drevo.account_id',?,true)").get("owner");
    assert.equal(
      (await primaryDb.prepare("", "UPDATE archive_memberships SET role='reader' WHERE archive_id='other-archive' AND user_id='owner'").run()).changes,
      0,
      "the extra read policy must not permit cross-archive writes",
    );
  });
  assert.equal(
    (await fetch(otherBase + "/api/session", { headers: ownerHeaders }).then((r) => r.json())).user.id,
    "owner",
  );
  assert.equal(
    (await fetch(otherBase + "/api/session", { headers }).then((r) => r.json())).user,
    null,
    "a session alone does not grant membership in another archive",
  );
  const samePhoto = JSON.stringify({
    id: "same-photo",
    title: "Same path",
    url: "/media/same.png",
    tags: [],
  });
  for (const runtime of [app, otherApp])
    await runtime.archive.db
      .prepare("", "INSERT INTO photos(id,data) VALUES('same-photo',?::jsonb)")
      .run(samePhoto);
  writeFileSync(join(directory, "uploads", "same.png"), "primary");
  writeFileSync(
    join(directory, "archives", "other-archive", "uploads", "same.png"),
    "secondary",
  );
  assert.equal(
    await fetch(securedBase + "/media/same.png", { headers: ownerHeaders }).then((r) => r.text()),
    "primary",
  );
  assert.equal(
    await fetch(otherBase + "/media/same.png", { headers: ownerHeaders }).then((r) => r.text()),
    "secondary",
  );
  assert.equal(
    await fetch(securedBase + "/a/other-archive/media/same.png", { headers: ownerHeaders }).then((r) => r.text()),
    "secondary",
  );
  assert.equal((await fetch(otherBase + "/media/same.png", { headers })).status, 401);
  // Discovery reads a global projection, never another archive's private graph.
  assert.equal(
    (await fetch(securedBase + "/api/discovery/people?q=Исправленный", { headers })).status,
    503,
  );
  const otherPublication = publishedPeopleStore(otherApp.archive.db);
  const livingDiscovery = await otherApp.archive.read();
  assert.notEqual(livingDiscovery.family.people[0].deceased, true);
  assert.equal(Boolean(livingDiscovery.family.people[0].death), false);
  await otherPublication.publish("person-a", "owner");
  assert.equal(
    (await fetch(otherBase + "/api/admin/published-people/person-a", { headers: ownerHeaders })
      .then((response) => response.json())).archiveId,
    "other-archive",
  );
  assert.equal(
    (await app.archive.db.prepare("", "SELECT count(*)::int AS count FROM discovery_people WHERE archive_id='other-archive' AND person_id='person-a'").get())?.count,
    0,
    "a living person cannot enter discovery even if a stale publication row exists",
  );
  await otherPublication.unpublish("person-a");
  const beforeDiscovery = await otherApp.archive.read();
  const deceasedFamily = structuredClone(beforeDiscovery.family);
  deceasedFamily.people[0].deceased = true;
  deceasedFamily.people[0].maidenName = "ПоискРождения";
  await otherApp.archive.write(deceasedFamily, beforeDiscovery.revision);
  const selectedDiscoveryFields = {
    birthSurname: true, birthYear: false, deathYear: false,
    birthPlace: false, deathPlace: false,
  };
  assert.equal((await fetch(otherBase + "/api/admin/published-people/batch", {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ personIds: ["person-a"], fields: selectedDiscoveryFields }),
  })).status, 200);
  assert.deepEqual((await (await fetch(otherBase + "/api/admin/published-people/batch?id=person-a", {
    headers: ownerHeaders,
  })).json()).fields["person-a"], selectedDiscoveryFields);
  await app.archive.db.prepare("", "UPDATE discovery_index_state SET ready=true WHERE singleton=true").run();
  const found = await fetch(securedBase + "/api/discovery/people?q=Исправленный", { headers });
  assert.equal(found.status, 200);
  assert.deepEqual(
    (await found.json()).results.map((person: { archiveId: string; id: string }) => [person.archiveId,person.id]),
    [["other-archive","person-a"]],
    "a root-archive reader can find only the explicitly published projection from another archive",
  );
  const chosenProjection = await fetch(securedBase + "/api/discovery/people/other-archive/person-a", { headers });
  assert.deepEqual(Object.keys((await chosenProjection.json()).person).sort(),
    ["archiveId", "birthSurname", "id", "name", "publicationVersion"].sort());
  assert.equal((await (await fetch(securedBase + "/api/discovery/people?q=ПоискРождения", { headers })).json()).results.length, 1);
  assert.equal(
    (await fetch(securedBase + "/api/discovery/people/other-archive/person-a", { headers })).status,
    200,
  );
  const rootBeforeMatch = await app.archive.read();
  const rootWithPublishedPerson = structuredClone(rootBeforeMatch.family);
  rootWithPublishedPerson.people[0].deceased = true;
  await app.archive.write(rootWithPublishedPerson, rootBeforeMatch.revision);
  const proposedPair = JSON.stringify({ sourcePersonId: "person-a", targetArchiveId: "other-archive",
    targetPersonId: "person-a", reason: "Совпадают семейные записи" });
  assert.equal((await fetch(securedBase + "/api/discovery/matches", {
    method: "POST", headers: ownerHeaders, body: proposedPair,
  })).status, 409, "a private card cannot be used in a cross-archive match");
  await publishedPeopleStore(app.archive.db).publish("person-a", "owner");
  assert.equal((await fetch(securedBase + "/api/discovery/matches", {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ sourcePersonId: "person-a", targetArchiveId: "other-archive",
      targetPersonId: "person-a", reason: "x".repeat(501) }),
  })).status, 400);
  const otherArchivesOnly = await fetch(securedBase +
    "/api/discovery/people?q=Тестов&excludeArchiveId=runtime-test", { headers });
  assert.deepEqual((await otherArchivesOnly.json()).results.map((person: { archiveId: string }) =>
    person.archiveId), ["other-archive"],
  "candidate search must exclude this archive before paginating, not after the client receives a page");
  const requestedMatch = await fetch(securedBase + "/api/discovery/matches", {
    method: "POST", headers: ownerHeaders,
    body: proposedPair,
  });
  assert.equal(requestedMatch.status, 200);
  const matchBody = await requestedMatch.json();
  assert.equal(matchBody.match.status, "pending");
  assert.equal(matchBody.match.reason, "Совпадают семейные записи");
  const matchDb = app.archive.db;
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get("unrelated-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_match_requests WHERE id=?`).get(matchBody.match.id))?.count, 0,
    "pending requests stay hidden outside the participating archives");
  }, true);
  assert.deepEqual((await (await fetch(securedBase + "/api/discovery/people/other-archive/person-a", {
    headers,
  })).json()).linkedCards, [], "a pending request must not appear on a published card");
  assert.equal([matchBody.match.left, matchBody.match.right]
    .find((person: { archiveId: string }) => person.archiveId === "other-archive")?.name,
    "Тестов Исправленный сосед");
  assert.doesNotMatch(JSON.stringify(matchBody), /biography|sources|parents/);
  assert.deepEqual((await (await fetch(otherBase + "/api/discovery/matches/own-people?q=Исправленный", {
    headers: ownerHeaders,
  })).json()).people.map((person: { id: string }) => person.id), ["person-a"]);
  const duplicateFromOtherSide = await fetch(otherBase + "/api/discovery/matches", {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ sourcePersonId: "person-a", targetArchiveId: "runtime-test", targetPersonId: "person-a" }),
  });
  assert.equal(duplicateFromOtherSide.status, 200);
  assert.equal((await duplicateFromOtherSide.json()).match.id, matchBody.match.id,
    "reversing the proposal must not create a second match");
  const matchPath = `/api/discovery/matches/${matchBody.match.id}`;
  const beforeReviewChange = await otherApp.archive.read();
  const changedBeforeReview = structuredClone(beforeReviewChange.family);
  changedBeforeReview.people[0].name = "Исправленный кандидат";
  await otherApp.archive.write(changedBeforeReview, beforeReviewChange.revision);
  assert.equal((await fetch(otherBase + matchPath, {
    method: "PATCH", headers: ownerHeaders,
    body: JSON.stringify({ decision: "accept", reviewToken: matchBody.match.reviewToken }),
  })).status, 409, "a changed published identity cannot be accepted using a stale review token");
  const freshReview = (await (await fetch(otherBase + "/api/discovery/matches", {
    headers: ownerHeaders,
  })).json()).matches[0];
  assert.notEqual(freshReview.reviewToken, matchBody.match.reviewToken);
  assert.equal((await fetch(securedBase + matchPath, {
    method: "PATCH", headers: ownerHeaders,
    body: JSON.stringify({ decision: "accept" }),
  })).status, 403, "an initiating archive cannot confirm its own request");
  const acceptedMatch = await fetch(otherBase + matchPath, {
    method: "PATCH", headers: ownerHeaders,
    body: JSON.stringify({ decision: "accept", reviewToken: freshReview.reviewToken }),
  });
  assert.equal(acceptedMatch.status, 200);
  assert.equal((await acceptedMatch.json()).match.status, "linked");
  const linkedPublicCard = await fetch(securedBase + "/api/discovery/people/other-archive/person-a", {
    headers,
  });
  const linkedPublicBody = await linkedPublicCard.json();
  assert.doesNotMatch(JSON.stringify(linkedPublicBody), /Совпадают семейные записи/,
    "the proposal note is visible to participant admins, not global discovery readers");
  assert.deepEqual(linkedPublicBody.linkedCards.map((person: { archiveId: string; id: string }) =>
    [person.archiveId,person.id]), [["runtime-test","person-a"]],
  "a signed-in reader can follow only the other published identity after both sides confirm");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get("unrelated-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_match_requests WHERE id=?`).get(matchBody.match.id))?.count, 1,
    "only confirmed matches can be read from an unrelated archive context");
  }, true);
  assert.equal((await fetch(securedBase + "/api/discovery/matches", { headers: ownerHeaders })
    .then((response) => response.json())).matches[0].status, "linked");
  assert.equal((await fetch(securedBase + "/api/discovery/matches", { headers })).status, 403);
  const beforeCandidates = await otherApp.archive.read();
  const similarCandidate = structuredClone(beforeCandidates.family);
  similarCandidate.people[0].name = "Иван";
  similarCandidate.people.push({ ...structuredClone(similarCandidate.people[0]),
    id: "person-b", name: "Иван", column: 1 });
  await otherApp.archive.write(similarCandidate, beforeCandidates.revision);
  await otherPublication.publish("person-b", "owner", selectedDiscoveryFields);
  const suggested = await fetch(securedBase + "/api/discovery/matches/candidates?sourcePersonId=person-a", {
    headers: ownerHeaders,
  });
  assert.equal(suggested.status, 200);
  const suggestedBody = await suggested.json();
  assert.deepEqual(suggestedBody.candidates.map((person: { archiveId: string; id: string }) =>
    [person.archiveId,person.id]), [["other-archive","person-b"]],
  "a confirmed link must not be suggested again");
  assert.equal(suggestedBody.candidates[0].birthYear, undefined,
    "candidate evidence must not disclose a birth year hidden by publication consent");
  assert.equal((await fetch(securedBase + "/api/discovery/matches/candidates?sourcePersonId=person-a", {
    headers,
  })).status, 403);
  const ignoredBody = JSON.stringify({ sourcePersonId: "person-a", targetArchiveId: "other-archive",
    targetPersonId: "person-b", ignored: true });
  assert.equal((await fetch(securedBase + "/api/discovery/matches/ignored", {
    method: "POST", headers, body: ignoredBody,
  })).status, 403);
  assert.equal((await fetch(securedBase + "/api/discovery/matches/ignored", {
    method: "POST", headers: ownerHeaders, body: ignoredBody,
  })).status, 200);
  assert.deepEqual((await (await fetch(securedBase +
    "/api/discovery/matches/candidates?sourcePersonId=person-a", { headers: ownerHeaders }))
    .json()).candidates, []);
  assert.deepEqual((await (await fetch(securedBase +
    "/api/discovery/matches/candidates?sourcePersonId=person-a&ignored=1", { headers: ownerHeaders }))
    .json()).candidates.map((person: { id: string }) => person.id), ["person-b"]);
  assert.equal((await fetch(securedBase + "/api/discovery/matches/ignored", {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ sourcePersonId: "person-a", targetArchiveId: "other-archive",
      targetPersonId: "person-b", ignored: false }),
  })).status, 200);
  assert.deepEqual((await (await fetch(securedBase +
    "/api/discovery/matches/candidates?sourcePersonId=person-a", { headers: ownerHeaders }))
    .json()).candidates.map((person: { id: string }) => person.id), ["person-b"]);
  const ignoredArchivePath = "/api/discovery/matches/ignored-archives";
  const archiveIgnoreBody = JSON.stringify({ targetArchiveId: "other-archive", ignored: true });
  assert.equal((await fetch(securedBase + ignoredArchivePath, {
    method: "POST", headers, body: archiveIgnoreBody,
  })).status, 403, "a reader cannot hide another archive");
  assert.equal((await fetch(securedBase + ignoredArchivePath, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ targetArchiveId: "unrelated-archive", ignored: true }),
  })).status, 409, "a tree without published cards cannot be probed by hiding it");
  assert.equal((await fetch(securedBase + ignoredArchivePath, {
    method: "POST", headers: ownerHeaders, body: archiveIgnoreBody,
  })).status, 200);
  assert.deepEqual((await (await fetch(securedBase +
    "/api/discovery/matches/candidates?sourcePersonId=person-a", { headers: ownerHeaders }))
    .json()).candidates, [], "hiding an archive removes all its automatic suggestions");
  assert.equal((await (await fetch(securedBase +
    "/api/discovery/people?q=Иван", { headers: ownerHeaders }))
    .json()).results.some((person: { archiveId: string }) =>
    person.archiveId === "other-archive"), true,
  "manual discovery remains available after hiding automatic suggestions");
  assert.deepEqual((await (await fetch(securedBase + ignoredArchivePath, {
    headers: ownerHeaders,
  })).json()).archives.map((item: { archiveId: string }) => item.archiveId),
  ["other-archive"]);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get("unrelated-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_ignored_archives WHERE archive_id='runtime-test'`).get())?.count, 0,
    "another archive cannot inspect the private dismissal list");
  }, true);
  assert.equal((await fetch(securedBase + ignoredArchivePath, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ targetArchiveId: "other-archive", ignored: false }),
  })).status, 200);
  assert.deepEqual((await (await fetch(securedBase +
    "/api/discovery/matches/candidates?sourcePersonId=person-a", { headers: ownerHeaders }))
    .json()).candidates.map((person: { id: string }) => person.id), ["person-b"],
  "restoring the archive returns its published candidates");
  await otherPublication.unpublish("person-a");
  await otherPublication.unpublish("person-b");
  assert.deepEqual((await (await fetch(securedBase + "/api/discovery/people/runtime-test/person-a", {
    headers,
  })).json()).linkedCards, [], "revoking either publication removes the transition");
  assert.equal((await fetch(securedBase + "/api/discovery/matches", { headers: ownerHeaders })
    .then((response) => response.json())).matches[0].status, "revoked",
    "revoking either publication closes a confirmed cross-archive match");
  assert.equal(
    (await fetch(securedBase + "/api/discovery/people/other-archive/person-a", { headers })).status,
    404,
    "revocation removes the global detail in the same transaction",
  );
  assert.deepEqual((await (await fetch(securedBase +
    "/api/discovery/matches/candidates?sourcePersonId=person-a", { headers: ownerHeaders }))
    .json()).candidates, [], "revocation must remove the candidate immediately");
  await publishedPeopleStore(app.archive.db).unpublish("person-a");
  const rootAfterMatch = await app.archive.read();
  const restoredRoot = structuredClone(rootAfterMatch.family);
  restoredRoot.people[0].deceased = false;
  await app.archive.write(restoredRoot, rootAfterMatch.revision);
  const afterDiscovery = await otherApp.archive.read();
  const restoredFamily = structuredClone(afterDiscovery.family);
  restoredFamily.people[0].deceased = false;
  await otherApp.archive.write(restoredFamily, afterDiscovery.revision);
  const originalClientId = process.env.YANDEX_CLIENT_ID;
  const originalClientSecret = process.env.YANDEX_CLIENT_SECRET;
  process.env.YANDEX_CLIENT_ID = "runtime-test-client";
  process.env.YANDEX_CLIENT_SECRET = "runtime-test-secret";
  const oauthFetch: typeof fetch = async (input, init) =>
    String(input).includes("/token")
      ? Response.json({ access_token: (init?.body as URLSearchParams).get("code") })
      : Response.json({ id: "new-account-probe", display_name: "New account" });
  const oauthApp = await startServer(0, source, true, oauthFetch);
  try {
    const oauthBase = `http://127.0.0.1:${(oauthApp.server.address() as { port: number }).port}`;
    const start = await fetch(oauthBase + "/auth/yandex", { redirect: "manual" });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const callback = await fetch(
      oauthBase + `/auth/yandex/callback?state=${state}&code=probe`,
      {
        headers: { Cookie: start.headers.getSetCookie()[0].split(";")[0] },
        redirect: "manual",
      },
    );
    assert.equal(callback.status, 303);
    const location = callback.headers.get("location")!;
    assert.match(location, /^\/a\/[a-f0-9-]{36}\/tree$/);
    const sessionCookie = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith("drevo_session="))!
      .split(";")[0];
    const newAccountSession = await fetch(
      oauthBase + location.replace(/\/tree$/, "/api/session"),
      { headers: { Cookie: sessionCookie } },
    ).then((response) => response.json());
    assert.equal(newAccountSession.user.role, "admin");
    assert.equal(newAccountSession.user.approved, true);
    assert.equal(newAccountSession.user.fullAccess, false);
    assert.deepEqual(
      (await fetch(oauthBase + "/api/account/archives", {
        headers: { Cookie: sessionCookie },
      }).then((response) => response.json())).archives.map((row: { id: string }) => row.id),
      [location.split("/")[2]],
    );
    const vkRegistration = await oauthApp.archive.db.postgresTransaction!((pgClient) =>
      completePostgresOAuthLoginInTransaction(
        pgClient,
        "vk",
        { id: "vk:987654321", name: "New VK account" },
      ),
    );
    assert.equal(vkRegistration.accountCreated, true);
    assert.equal(vkRegistration.archiveCreated, true);
    assert.notEqual(vkRegistration.archiveId, location.split("/")[2]);
  } finally {
    await oauthApp.close();
    if (originalClientId === undefined) delete process.env.YANDEX_CLIENT_ID;
    else process.env.YANDEX_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.YANDEX_CLIENT_SECRET;
    else process.env.YANDEX_CLIENT_SECRET = originalClientSecret;
  }
  const beforeBackfill = await otherApp.archive.read();
  const backfillFamily = structuredClone(beforeBackfill.family);
  backfillFamily.people[0].deceased = true;
  await otherApp.archive.write(backfillFamily, beforeBackfill.revision);
  await publishedPeopleStore(otherApp.archive.db).publish("person-a", "owner");
  await app.archive.db.prepare("", "UPDATE discovery_index_state SET ready=false WHERE singleton=true").run();
  console.log("runtime_http_and_backup_ok");
} finally {
  await otherApp?.close();
  await app?.close();
  await live?.close();
  await client.end();
  rmSync(directory, { recursive: true, force: true });
}
