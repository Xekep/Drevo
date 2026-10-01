import { readStorageLimits, writeStorageLimits, enforceUserStorageLimit } from "../../src/server/storage-limits.ts";
import { DEFAULT_STORAGE_LIMITS } from "../../src/shared/storage-limits.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { vkAuthSettingsStore } from "../../src/server/vk-auth-settings.ts";
import { createWriteStream, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pg from "pg";
import PDFDocument from "pdfkit";
import { openPromise } from "yauzl";
import {
  newSessionToken,
  sessionTokenHash,
} from "../../src/server/session-token.ts";
import { openPostgresDatabase } from "../../src/server/store-database.ts";
import { initializePostgresRuntimeSchema } from "../../src/server/postgres-runtime-schema.ts";
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
import { sharesStore } from "../../src/server/shares.ts";
import { publicShareAccess } from "../../src/server/public-share-access.ts";
import { treePreferencesStore } from "../../src/server/tree-preferences.ts";
import { publishedPeopleStore } from "../../src/server/published-people.ts";
import { accountArchiveDirectory } from "../../src/server/account-archives.ts";
import { completePostgresOAuthLoginInTransaction } from "../../src/server/postgres-yandex-login.ts";
import { verifyEmailAccounts } from "./postgres-email.ts";
import { verifyPostgresCommentEdits } from "./postgres-comment-edits.ts";
import { importSqliteSnapshot } from "../../ops/postgres/import-sqlite.ts";
import { writeDatabaseBackup } from "../../src/server/backup.ts";
import { startServer } from "../../src/server/index.ts";
import { adaptLegacyAiFake } from "../legacy-ai-fake.ts";
import {
  BASIC_MEDIA_BYTES,
  enforcePostgresMediaQuota,
  releaseAttachedMediaGrants,
} from "../../src/server/postgres-media-quota.ts";
import { uploadQuota, UploadQuotaError } from "../../src/server/upload-quota.ts";
import { reservePlatformDisk } from "../../src/server/platform-disk-reservation.ts";
import { registerMediaUpload } from "../../src/server/media-access.ts";
import type { Family } from "../../src/domain/types.ts";
import { planAdditions } from "../../src/domain/additions-import.ts";
import { listAdditionBatches, planUndoAdditions } from "../../src/server/additions-undo.ts";
import { auditStore } from "../../src/server/audit.ts";
import { writePortablePackage } from "../../src/server/portable-package.ts";
import { createSharedRequestLimiter } from "../../src/server/shared-request-rate-limit.ts";

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
assert.equal((await client.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed")).rows[0].allowed, true,
  "the runtime database owner must be able to install trusted pg_trgm");
assert.equal((await client.query("SELECT 1 FROM pg_extension WHERE extname='pg_trgm'")).rowCount, 0,
  "the runtime migration must install pg_trgm in a fresh database");
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
  await sqlite.db.prepare("INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text,updated_ms) VALUES('person-a','owner','Владелец',1000,'Правка до переноса',2000),('person-a','owner','Владелец',1001,'Без правок',NULL)").run();
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
  await client.query("BEGIN");
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',true)");
  assert.deepEqual((await client.query("SELECT text,updated_ms FROM person_comments WHERE archive_id='runtime-test' ORDER BY id")).rows,
    [{ text: "Правка до переноса", updated_ms: "2000" }, { text: "Без правок", updated_ms: null }]);
  await client.query("DELETE FROM person_comments WHERE archive_id='runtime-test'");
  await client.query("COMMIT");
  process.env.DATABASE_BACKEND = "postgres";
  process.env.ARCHIVE_ID = "runtime-test";
  // Simulate the deployed schema before the additive VK extension.
  await client.query("DROP TABLE vk_auth_settings");
  await client.query("ALTER TABLE ai_settings DROP COLUMN role_profiles");
  await client.query("ALTER TABLE documents DROP COLUMN annotations");
  live = await openArchive(source, family);
  assert.equal(live.db.kind, "postgres");
  assert.equal((await client.query("SELECT 1 FROM pg_extension WHERE extname='pg_trgm'")).rowCount, 1,
    "the non-superuser runtime migration installs trusted pg_trgm");
  // A second application must safely finish an already installed extension.
  await client.query(readFileSync(new URL("../../ops/postgres/049_discovery_candidate_signals.sql", import.meta.url), "utf8"));
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM pg_trigger
    WHERE tgname='refresh_discovery_relatives_after_relation' AND NOT tgisinternal`)).rows[0].count, 1);
  const adminClient = process.env.PGADMINUSER
    ? new pg.Client({ user: process.env.PGADMINUSER, password: process.env.PGADMINPASSWORD })
    : client;
  if (adminClient !== client) await adminClient.connect();
  try {
    await adminClient.query(readFileSync(new URL("../../ops/postgres/install-account-history-anonymization.sql", import.meta.url), "utf8"));
    const runtimeRole = process.env.PGUSER || "";
    assert.match(runtimeRole, /^[a-z_][a-z0-9_]*$/);
    await adminClient.query(`GRANT EXECUTE ON FUNCTION public.runtime_anonymize_deleted_account_history(text) TO ${runtimeRole}`);
    await adminClient.query(`GRANT EXECUTE ON FUNCTION public.runtime_redact_deleted_account_comments(text) TO ${runtimeRole}`);
  } finally {
    if (adminClient !== client) await adminClient.end();
  }
  const runtimePrivileges = (await client.query(`SELECT
    has_function_privilege(current_user,'public.runtime_anonymize_deleted_account_history(text)','EXECUTE') AS entrypoint,
    has_function_privilege(current_user,'public.runtime_redact_deleted_account_comments(text)','EXECUTE') AS comment_redaction,
    has_function_privilege(current_user,'public.runtime_anonymize_account_history_rows(text)','EXECUTE') AS internal,
    has_function_privilege(current_user,'public.runtime_redact_account_attribution(jsonb,text)','EXECUTE') AS helper,
    (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged`)).rows[0];
  if (!runtimePrivileges.privileged) {
    assert.equal(runtimePrivileges.entrypoint, true);
    assert.equal(runtimePrivileges.comment_redaction, true);
    assert.equal(runtimePrivileges.internal, false);
    assert.equal(runtimePrivileges.helper, false);
  }
  await assert.rejects(
    client.query("SELECT public.runtime_anonymize_deleted_account_history('owner')"),
    (error: unknown) => (error as { code?: string }).code === "42501",
    "the privileged entry point rejects a call outside account deletion",
  );
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
    const diskOptions = {
      bytes: 1_000,
      freeReserve: 10,
      requestsPerHour: 100,
      concurrent: 100,
    };
    const firstUpload = uploadQuota(live.db, diskOptions);
    const otherUpload = uploadQuota(other, diskOptions);
    const reservations = await Promise.allSettled([
      firstUpload.acquire("first-uploader", 70, 100),
      otherUpload.acquire("other-uploader", 70, 100),
    ]);
    assert.equal(reservations.filter((result) => result.status === "fulfilled").length, 1,
      "two archives cannot reserve the same physical free space concurrently");
    const rejectedReservation = reservations.find((result) => result.status === "rejected");
    assert.ok(rejectedReservation?.status === "rejected" &&
      rejectedReservation.reason instanceof UploadQuotaError &&
      rejectedReservation.reason.status === 507);
    const grantedReservation = reservations.find((result) => result.status === "fulfilled");
    assert.ok(grantedReservation?.status === "fulfilled");
    await grantedReservation.value();
    assert.equal((await client.query("SELECT count(*)::int AS n FROM platform_upload_reservations")).rows[0].n, 0,
      "finishing an upload releases the platform reservation");
    await (await (reservations[0].status === "rejected" ?
      firstUpload.acquire("first-uploader", 70, 100) :
      otherUpload.acquire("other-uploader", 70, 100)))();

    let uploadClock = Date.now();
    const longUpload = uploadQuota(live.db, {
      ...diskOptions,
      reservationMs: 5_000,
      renewEveryMs: 25,
      now: () => uploadClock,
    });
    const releaseLongUpload = await longUpload.acquire("long-uploader", 70, 100);
    try {
      const initialExpiry = Number((await client.query(
        "SELECT expires_ms FROM platform_upload_reservations",
      )).rows[0].expires_ms);
      uploadClock += 2_500;
      let renewedExpiry = initialExpiry;
      for (let attempt = 0; attempt < 40 && renewedExpiry === initialExpiry; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        renewedExpiry = Number((await client.query(
          "SELECT expires_ms FROM platform_upload_reservations",
        )).rows[0].expires_ms);
      }
      assert.ok(renewedExpiry > initialExpiry,
        "a long-running import renews the shared platform reservation");
      await releaseLongUpload.assertValid();
      await assert.rejects(otherUpload.acquire("cross-archive", 70, 100),
        (error) => error instanceof UploadQuotaError && error.status === 507);
    } finally {
      await releaseLongUpload();
    }
    await assert.rejects(releaseLongUpload.assertValid(), UploadQuotaError);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM platform_upload_reservations")).rows[0].n, 0);

    const previewSpace = await reservePlatformDisk(live.db, 40, async () => 100, {
      freeReserve: 10,
    });
    try {
      await previewSpace.grow(40);
      await previewSpace.assertValid();
      await assert.rejects(previewSpace.grow(15),
        (error) => error instanceof UploadQuotaError && error.status === 507);
      await assert.rejects(otherUpload.acquire("other-preview", 30, 100),
        (error) => error instanceof UploadQuotaError && error.status === 507,
        "a temporary preview reserves physical disk space against other archives");
    } finally {
      await previewSpace.release();
    }
    await assert.rejects(previewSpace.assertValid(), UploadQuotaError);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM platform_upload_reservations")).rows[0].n, 0);
    await (await otherUpload.acquire("after-preview", 30, 100))();

    const firstBudget = createSharedRequestLimiter(live.db, "runtime-shared-test", { windowMs: 60_000, limit: 3 });
    const secondBudget = createSharedRequestLimiter(other, "runtime-shared-test", { windowMs: 60_000, limit: 3 });
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? firstBudget : secondBudget).allow("one-account")));
    assert.equal(attempts.filter(Boolean).length, 3,
      "parallel archive runtimes share exactly one atomic request budget");
    assert.equal(await secondBudget.allow("one-account"), false);
    assert.equal(await secondBudget.allow("another-account"), true);
    assert.equal(await createSharedRequestLimiter(other, "another-scope", { windowMs: 60_000, limit: 1 }).allow("one-account"), true);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM request_rate_limits WHERE key_hash='one-account'")).rows[0].n, 0,
      "the rate-limit table stores a digest, not a raw account or IP");
    await client.query("UPDATE request_rate_limits SET started_at=0 WHERE scope='runtime-shared-test'");
    assert.equal(await firstBudget.allow("one-account"), true,
      "an expired window starts a new budget");
    const sameArchive = await openPostgresDatabase("runtime-test", source);
    try {
      let entered!: () => void;
      let release!: () => void;
      const active = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const firstExport = live.db.withExclusiveArchiveTask!("offline-export", async () => {
        entered();
        await held;
        return "first";
      });
      void firstExport.then(entered, entered);
      try {
        await active;
        assert.deepEqual(await sameArchive.withExclusiveArchiveTask!("offline-export", async () => "second"),
          { acquired: false }, "another backend cannot export the same archive concurrently");
        assert.deepEqual(await other.withExclusiveArchiveTask!("offline-export", async () => "other tree"),
          { acquired: true, value: "other tree" }, "another archive has an independent export lock");
      } finally {
        release();
      }
      assert.deepEqual(await firstExport, { acquired: true, value: "first" });
      assert.deepEqual(await sameArchive.withExclusiveArchiveTask!("offline-export", async () => "second"),
        { acquired: true, value: "second" }, "the lock is released after export");
    } finally {
      await sameArchive.close();
    }
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
  const generationLimits = { anchorId: "runtime-person", ancestors: 7, descendants: 50, collateral: 2 };
  await preferences.write("owner", { reverseTimeline: false, generationLimits });
  assert.deepEqual((await preferences.read("owner")).generationLimits, generationLimits);
  assert.equal((await preferences.read("reader")).generationLimits, undefined);
  await assert.rejects(preferences.write("owner", { reverseTimeline: false, generationLimits: { ...generationLimits, collateral: 3 } }), /Некорректные/);
  await preferences.write("owner", { reverseTimeline: false, generationLimits: null });
  assert.equal((await preferences.read("owner")).generationLimits, undefined);
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
  const linkedBefore = await app.archive.read();
  const linkedFamily = structuredClone(linkedBefore.family);
  linkedFamily.people.find((person) => person.id === "person-a")!.sources.push({
    title: "Семейная запись",
    type: "PDF",
    reference: "",
    documentId,
  });
  await app.archive.write(linkedFamily, linkedBefore.revision);
  assert.equal(
    (await fetch(base + "/api/documents/" + documentId, { method: "DELETE" })).status,
    409,
  );
  const unlinkedBefore = await app.archive.read();
  const unlinkedFamily = structuredClone(unlinkedBefore.family);
  unlinkedFamily.people.find((person) => person.id === "person-a")!.sources =
    linkedBefore.family.people.find((person) => person.id === "person-a")!.sources;
  await app.archive.write(unlinkedFamily, unlinkedBefore.revision);
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
  const basicHistoryResponse = await fetch(securedBase + "/api/ai/chats", { headers });
  assert.equal(basicHistoryResponse.status, 200);
  assert.deepEqual((await basicHistoryResponse.json()).chats, []);
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
  await client.query(
    "INSERT INTO account_email_credentials(account_id,email,password_hash) VALUES('reader','reader-export@example.invalid','secret-hash-sentinel')",
  );
  await client.query(
    "INSERT INTO account_identities(provider,subject,account_id) VALUES('email','reader-export@example.invalid','reader')",
  );
  const accountExportUrl = securedBase + "/api/account/export";
  assert.equal((await fetch(accountExportUrl)).status, 401);
  assert.equal((await fetch(accountExportUrl, { method: "POST", headers: ownerHeaders })).status, 405);
  const accountExports = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      fetch(accountExportUrl, { headers: index % 2 ? headers : ownerHeaders }),
    ),
  );
  for (const [index, response] of accountExports.entries()) {
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get("content-disposition") || "", /attachment/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const raw = await response.text();
    assert.doesNotMatch(raw, /secret-hash-sentinel|password_hash|token_hash|drevo_session/);
    const exported = JSON.parse(raw);
    assert.equal(exported.format, "drevo-account-data");
    assert.equal(exported.account.id, index % 2 ? "reader" : "owner");
    assert.equal(exported.account.verifiedEmail, index % 2 ? "reader-export@example.invalid" : null);
    assert.deepEqual(exported.archives.map((item: { id: string }) => item.id), ["runtime-test"]);
    assert.equal(exported.archives[0].role, index % 2 ? "reader" : "admin");
    assert.equal(exported.archives[0].owned, index % 2 === 0);
    assert.equal(exported.archives[0].preferences?.colorScheme, index % 2 ? undefined : "white");
  }
  const chatToDeleteAfterDowngrade = await aiChatStore(app.archive.db).create("owner", "[]");
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
  const aiAccessDb = app.archive.db;
  await assert.rejects(accountAiAccess(aiAccessDb, "vk:42", false, true),
    /транзакции/, "a tier lock must not silently run outside the saving transaction");
  let lockReady!: () => void;
  let releaseTierLock!: () => void;
  const lockAcquired = new Promise<void>((resolve) => { lockReady = resolve; });
  const tierRelease = new Promise<void>((resolve) => { releaseTierLock = resolve; });
  const guardedSave = aiAccessDb.transaction(async () => {
    assert.equal(await accountAiAccess(aiAccessDb, "vk:42", false, true), true);
    lockReady();
    await tierRelease;
  });
  await lockAcquired;
  const downgradeWhileSaving = client.query(
    "UPDATE account_tiers SET full_access=false WHERE account_id='vk:42'",
  );
  try {
    assert.equal(await Promise.race([
      downgradeWhileSaving.then(() => "changed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]), "waiting", "downgrading waits for an already authorized save to commit");
  } finally {
    releaseTierLock();
    await guardedSave;
  }
  await downgradeWhileSaving;
  assert.equal(await accountAiAccess(app.archive.db, "vk:42"), false);
  await client.query("UPDATE account_tiers SET full_access=true WHERE account_id='vk:42'");
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
  const cleanupListResponse = await fetch(securedBase + "/api/ai/chats", {
    headers: ownerHeaders,
  });
  assert.equal(cleanupListResponse.status, 200);
  const cleanupList = await cleanupListResponse.json() as {
    chats: Array<{ id: string; title: string; unavailable?: boolean }>;
  };
  assert.deepEqual(
    cleanupList.chats.find((chat) => chat.id === chatToDeleteAfterDowngrade.id),
    {
      id: chatToDeleteAfterDowngrade.id,
      updatedAt: chatToDeleteAfterDowngrade.updatedAt,
      title: "Диалог с прежними правами доступа",
      unavailable: true,
    },
    "a downgraded account can locate its own history without seeing old chat text",
  );
  const cleanupPath = `/api/ai/chats/${chatToDeleteAfterDowngrade.id}`;
  assert.equal((await fetch(securedBase + cleanupPath, {
    headers: ownerHeaders,
  })).status, 403, "listing history does not restore access to messages");
  assert.equal((await fetch(securedBase + `${cleanupPath}/stop`, {
    method: "POST", headers: ownerHeaders,
  })).status, 200, "a downgraded account can stop its existing work");
  assert.equal((await fetch(securedBase + cleanupPath, {
    method: "DELETE", headers: { ...ownerHeaders, Origin: "https://evil.example" },
  })).status, 403, "history deletion still requires same-origin protection");
  assert.equal((await fetch(securedBase + cleanupPath, {
    method: "DELETE", headers: ownerHeaders,
  })).status, 200, "a downgraded account can delete its own stored AI history");
  assert.equal(await aiChatStore(app.archive.db).read(chatToDeleteAfterDowngrade.id, "owner"), null);
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
  const originalArchiveRead = app.archive.read;
  let downgradeDuringExport = true;
  app.archive.read = async () => {
    const snapshot = await originalArchiveRead();
    if (downgradeDuringExport) {
      downgradeDuringExport = false;
      await client.query("UPDATE account_tiers SET full_access=false WHERE account_id='owner'");
    }
    return snapshot;
  };
  try {
    assert.equal((await fetch(securedBase + "/api/ai/export/gedcom?format=gedcom7", {
      headers: ownerHeaders,
    })).status, 403, "a downgrade during export must stop delivery of the prepared file");
  } finally {
    app.archive.read = originalArchiveRead;
    await client.query("UPDATE account_tiers SET full_access=true WHERE account_id='owner'");
  }
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
  await verifyPostgresCommentEdits(securedBase, ownerHeaders, archiveAdminHeaders);
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
  const peopleBeforeQuota = await app.archive.read();
  assert.ok(peopleBeforeQuota.family.people.length < 149);
  const quotaFamily = (count: number): Family => ({
    ...peopleBeforeQuota.family,
    people: [
      ...peopleBeforeQuota.family.people,
      ...Array.from({ length: count - peopleBeforeQuota.family.people.length }, (_, index) => ({
        ...family.people[0],
        id: `basic-quota-${index}`,
        name: `Quota ${index}`,
        column: index + 10,
      })),
    ],
  });
  const saveQuotaFamily = (value: Family, revision: number) =>
    fetch(securedBase + "/api/family", {
      method: "PUT",
      headers: {
        Cookie: `drevo_session=${ownerToken}`,
        Origin: process.env.PUBLIC_ORIGIN!,
        "Content-Type": "application/json",
        "If-Match": String(revision),
      },
      body: JSON.stringify(value),
    });
  const rejectedPeople = await saveQuotaFamily(quotaFamily(151), peopleBeforeQuota.revision);
  assert.equal(rejectedPeople.status, 403, await rejectedPeople.text());
  await assert.rejects(
    app.archive.write(quotaFamily(151), peopleBeforeQuota.revision),
    /150/,
    "background imports through archive.write must obey the owner's tier",
  );
  assert.equal((await app.archive.read()).revision, peopleBeforeQuota.revision);
  assert.equal(
    (await quotaDb.prepare("", "SELECT count(*) AS count FROM people").get())?.count,
    peopleBeforeQuota.family.people.length,
  );
  const nearLimit = await saveQuotaFamily(quotaFamily(149), peopleBeforeQuota.revision);
  assert.equal(nearLimit.status, 200, await nearLimit.text());
  const nearLimitRevision = (await app.archive.read()).revision;
  const competingSaves = await Promise.all([
    saveQuotaFamily(quotaFamily(150), nearLimitRevision),
    saveQuotaFamily(quotaFamily(150), nearLimitRevision),
  ]);
  assert.deepEqual(competingSaves.map((response) => response.status).sort(), [200, 409]);
  const afterCompetingSaves = await app.archive.read();
  assert.equal(afterCompetingSaves.family.people.length, 150);
  await app.archive.write(peopleBeforeQuota.family, afterCompetingSaves.revision);
  assert.equal((await app.archive.read()).family.people.length,
    peopleBeforeQuota.family.people.length,
    "shrinking an archive remains possible for a basic owner");
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
      .prepare("", "UPDATE account_tiers SET full_access=true WHERE account_id='owner'")
      .run();
    await quotaDb
      .prepare(
        "",
        "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES('quota-over','Over limit','over limit','quota-over.pdf',1,'owner',?)",
      )
      .run(new Date().toISOString());
    await quotaDb
      .prepare("", "UPDATE account_tiers SET full_access=false WHERE account_id='owner'")
      .run();
    await enforcePostgresMediaQuota(quotaDb, BASIC_MEDIA_BYTES + 1);
  });
  assert.equal(
    (await quotaDb.prepare("", "SELECT count(*) AS n FROM documents").get())?.n,
    2,
  );
  await assert.rejects(
    quotaDb.transaction(async () => {
      await quotaDb
        .prepare(
          "",
          "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES('quota-growth','Growth','growth','quota-growth.pdf',1,'owner',?)",
        )
        .run(new Date().toISOString());
      await enforcePostgresMediaQuota(quotaDb, BASIC_MEDIA_BYTES + 1);
    }),
    (error) => error instanceof UploadQuotaError,
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
  await registerMediaUpload(quotaDb, "/media/pre-downgrade.jpg", "owner",
    BASIC_MEDIA_BYTES + 1);
  await client.query("UPDATE account_tiers SET full_access=false WHERE account_id='owner'");
  const beforeDowngradedAttach = await app.archive.read();
  const attachedAfterDowngrade = await app.archive.appendPhoto({
    id: "pre-downgrade-photo", url: "/media/pre-downgrade.jpg", title: "", tags: [],
  }, beforeDowngradedAttach.revision, owner);
  assert.equal(attachedAfterDowngrade.family.photos?.some((photo) =>
    photo.id === "pre-downgrade-photo"), true,
  "an already-counted original can be attached despite an exceeded downgraded quota");
  await assert.rejects(registerMediaUpload(quotaDb, "/media/new-after-downgrade.jpg",
    "owner", 1), UploadQuotaError, "new media still cannot grow an exceeded archive");
  await app.archive.write({ ...attachedAfterDowngrade.family,
    photos: attachedAfterDowngrade.family.photos?.filter((photo) =>
      photo.id !== "pre-downgrade-photo") }, attachedAfterDowngrade.revision, owner);
  await quotaDb.prepare("", "DELETE FROM media_originals WHERE url='/media/pre-downgrade.jpg'").run();
  await client.query("UPDATE account_tiers SET full_access=true WHERE account_id='owner'");
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
  assert.equal(
    ownerArchives.archives.find((archive: { id: string }) => archive.id === "runtime-test").owned,
    true,
  );
  const readerArchives = await fetch(securedBase + "/api/account/archives", {
    headers,
  }).then((r) => r.json());
  assert.deepEqual(readerArchives.archives.map((archive: { id: string }) => archive.id), ["runtime-test"]);
  assert.equal(readerArchives.archives[0].owned, false);
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
  const requestedAudit = await matchDb.prepare("", `SELECT requested_by,request_review_token,
    decision_review_token,responded_by FROM discovery_match_requests WHERE id=?`)
    .get(matchBody.match.id);
  assert.equal(requestedAudit?.requested_by, "owner");
  assert.equal(requestedAudit?.request_review_token, matchBody.match.reviewToken);
  assert.equal(requestedAudit?.decision_review_token, null);
  assert.equal(requestedAudit?.responded_by, null);
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
  assert.equal((await matchDb.prepare("", `SELECT request_review_token FROM discovery_match_requests
    WHERE id=?`).get(matchBody.match.id))?.request_review_token, matchBody.match.reviewToken,
  "an idempotent reverse proposal preserves the original reviewed revision");
  const matchPath = `/api/discovery/matches/${matchBody.match.id}`;
  assert.equal((await fetch(securedBase + matchPath + "/card-share", {
    headers: ownerHeaders,
  })).status, 404, "a pending proposal never grants additional card access");
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
  assert.equal(freshReview.changedSinceRequest, true,
    "the responding owner sees that the published cards changed after proposal");
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
  const acceptedAudit = await matchDb.prepare("", `SELECT requested_by,request_review_token,
    responded_by,responded_at,decision_review_token FROM discovery_match_requests WHERE id=?`)
    .get(matchBody.match.id);
  assert.equal(acceptedAudit?.requested_by, "owner");
  assert.equal(acceptedAudit?.request_review_token, matchBody.match.reviewToken);
  assert.equal(acceptedAudit?.responded_by, "owner");
  assert.ok(acceptedAudit?.responded_at);
  assert.equal(acceptedAudit?.decision_review_token, freshReview.reviewToken);
  assert.equal((await fetch(otherBase + matchPath, {
    method: "PATCH", headers: ownerHeaders,
    body: JSON.stringify({ decision: "accept", reviewToken: freshReview.reviewToken }),
  })).status, 200, "repeating the accepted decision is idempotent");
  assert.equal((await matchDb.prepare("", `SELECT decision_review_token FROM discovery_match_requests
    WHERE id=?`).get(matchBody.match.id))?.decision_review_token, freshReview.reviewToken);
  await client.query(readFileSync(new URL("../../ops/postgres/050_discovery_match_audit.sql", import.meta.url), "utf8"));
  assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count FROM discovery_linked_pairs
    WHERE left_archive_id='other-archive' AND right_archive_id='runtime-test'`).get())?.count, 1,
  "reapplying the additive projection migration keeps one linked pair");
  const backfillAdmin = process.env.PGADMINUSER
    ? new pg.Client({ user: process.env.PGADMINUSER, password: process.env.PGADMINPASSWORD })
    : client;
  if (backfillAdmin !== client) await backfillAdmin.connect();
  try {
    await backfillAdmin.query(readFileSync(
      new URL("../../ops/postgres/backfill-discovery.sql", import.meta.url), "utf8"));
  } finally {
    if (backfillAdmin !== client) await backfillAdmin.end();
  }
  assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count FROM discovery_linked_pairs
    WHERE left_archive_id='other-archive' AND right_archive_id='runtime-test'`).get())?.count, 1,
  "administrator backfill rebuilds the confirmed public transition after truncation");
  await client.query(readFileSync(new URL("../../ops/postgres/051_discovery_linked_request_rls.sql", import.meta.url), "utf8"));
  await initializePostgresRuntimeSchema(matchDb);
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM pg_policies
    WHERE schemaname=current_schema() AND tablename='discovery_match_requests'
      AND policyname='linked_discovery_read'`)).rows[0].count, 0,
  "a runtime schema check must not recreate the removed global read policy");
  assert.deepEqual((await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='discovery_linked_pairs'
    ORDER BY ordinal_position`)).rows.map((row) => row.column_name),
  ["left_archive_id","left_person_id","right_archive_id","right_person_id"],
  "the public projection contains no reason, actor or review digest");
  const linkedPublicCard = await fetch(securedBase + "/api/discovery/people/other-archive/person-a", {
    headers,
  });
  const linkedPublicBody = await linkedPublicCard.json();
  assert.doesNotMatch(JSON.stringify(linkedPublicBody), /Совпадают семейные записи/,
    "the proposal note is visible to participant admins, not global discovery readers");
  assert.deepEqual(linkedPublicBody.linkedCards.map((person: { archiveId: string; id: string }) =>
    [person.archiveId,person.id]), [["runtime-test","person-a"]],
  "a signed-in reader can follow only the other published identity after both sides confirm");
  const cardSharePath = `/api/discovery/matches/${matchBody.match.id}/card-share`;
  assert.equal((await fetch(securedBase + cardSharePath, { headers })).status, 403,
    "a reader of the published card cannot inspect private share grants");
  const shareBeforeEdit = await app.archive.read();
  const shareFamily = structuredClone(shareBeforeEdit.family);
  shareFamily.people[0].occupation = "Архивный исследователь";
  shareFamily.people[0].biography = "Закрытая биография и источники";
  await app.archive.write(shareFamily,shareBeforeEdit.revision);
  const sharePreview = await fetch(securedBase + cardSharePath, { headers: ownerHeaders })
    .then((response) => response.json());
  assert.equal(sharePreview.available.occupation, "Архивный исследователь");
  assert.equal(sharePreview.available.biography, undefined);
  assert.equal(sharePreview.incoming, null);
  assert.equal(sharePreview.outgoing, null);
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["biography"], previewToken: sharePreview.previewToken }),
  })).status, 400, "free-form biography cannot enter a scalar card grant");
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["occupation"], previewToken: "0".repeat(64) }),
  })).status, 409, "a stale card preview cannot authorize a new snapshot");
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["occupation"], previewToken: sharePreview.previewToken }),
  })).status, 200);
  const incomingShare = await fetch(otherBase + cardSharePath, { headers: ownerHeaders })
    .then((response) => response.json());
  assert.deepEqual(incomingShare.incoming.fields, { occupation: "Архивный исследователь" });
  assert.doesNotMatch(JSON.stringify(incomingShare), /Закрытая биография|sources|parents/,
    "the grant response contains only the chosen scalar snapshot");
  await assert.rejects(matchDb.prepare("", `UPDATE discovery_linked_card_grants
    SET fields=?::jsonb WHERE grantor_archive_id='runtime-test'`).run(
    JSON.stringify({ biography: "Закрытая биография" })),
  (error: unknown) => (error as { code?: string }).code === "23514",
  "the database rejects unapproved private fields even outside HTTP");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get("unrelated-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_linked_card_grants WHERE left_person_id='person-a'`).get())?.count, 0,
    "RLS hides even the presence of a card grant from an unrelated archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM people WHERE archive_id='runtime-test' AND id='person-a'`).get())?.count, 0,
    "the grant never opens the source people row across archives");
  }, true);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT fields->>'occupation' AS occupation
      FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'`).get())?.occupation,
    "Архивный исследователь");
    assert.equal((await matchDb.prepare("", `DELETE FROM discovery_linked_card_grants
      WHERE grantor_archive_id='runtime-test'`).run()).changes, 0,
    "the receiving archive cannot revoke the owner's grant through SQL");
  }, true);
  const shareAdmin = process.env.PGADMINUSER
    ? new pg.Client({ user: process.env.PGADMINUSER, password: process.env.PGADMINPASSWORD })
    : client;
  if (shareAdmin !== client) await shareAdmin.connect();
  try {
    await shareAdmin.query(readFileSync(
      new URL("../../ops/postgres/backfill-discovery.sql", import.meta.url), "utf8"));
  } finally {
    if (shareAdmin !== client) await shareAdmin.end();
  }
  assert.equal((await matchDb.prepare("", `SELECT fields->>'occupation' AS occupation
    FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'`).get())?.occupation,
  "Архивный исследователь", "administrator backfill preserves a still-confirmed grant");
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "DELETE", headers: ownerHeaders,
  })).status, 200);
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "DELETE", headers: ownerHeaders,
  })).status, 200, "repeated grant revocation is idempotent");
  assert.equal((await fetch(otherBase + cardSharePath, { headers: ownerHeaders })
    .then((response) => response.json())).incoming, null,
  "revocation hides the snapshot from the other side immediately");
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["occupation"], previewToken: sharePreview.previewToken }),
  })).status, 200);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get("unrelated-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_match_requests WHERE id=?`).get(matchBody.match.id))?.count, 0,
    "a linked request still hides its reason and actors from unrelated archives");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_linked_pairs WHERE left_archive_id='other-archive'
        AND right_archive_id='runtime-test'`).get())?.count, 1,
    "an unrelated archive sees only the published transition keys");
  }, true);
  for (const participantArchive of ["runtime-test", "other-archive"]) {
    await matchDb.transaction(async () => {
      await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
        .get(participantArchive);
      const participantView = await matchDb.prepare("", `SELECT reason,requested_by,responded_by
        FROM discovery_match_requests WHERE id=?`).get(matchBody.match.id);
      assert.deepEqual(participantView, {
        reason: "Совпадают семейные записи", requested_by: "owner", responded_by: "owner",
      }, "both participating archives retain their private review details");
    }, true);
  }
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
  const manualHeaders = { ...ownerHeaders, "X-Real-IP": "198.51.100.101" };
  const rejectedRequest = await fetch(securedBase + "/api/discovery/matches", {
    method: "POST", headers: manualHeaders,
    body: JSON.stringify({ sourcePersonId: "person-a", targetArchiveId: "other-archive",
      targetPersonId: "person-b", reason: "Проверить запись" }),
  });
  assert.equal(rejectedRequest.status, 200);
  const rejectedId = (await rejectedRequest.json()).match.id as string;
  const rejectedPath = `/api/discovery/matches/${rejectedId}`;
  assert.equal((await fetch(otherBase + rejectedPath, {
    method: "PATCH", headers: manualHeaders, body: JSON.stringify({ decision: "reject" }),
  })).status, 200);
  const rejectedAudit = await matchDb.prepare("", `SELECT status,requested_by,responded_by,
    request_review_token,decision_review_token FROM discovery_match_requests WHERE id=?`)
    .get(rejectedId);
  assert.equal(rejectedAudit?.status, "rejected");
  assert.equal(rejectedAudit?.requested_by, "owner");
  assert.equal(rejectedAudit?.responded_by, "owner");
  assert.match(String(rejectedAudit?.request_review_token), /^[0-9a-f]{64}$/);
  assert.match(String(rejectedAudit?.decision_review_token), /^[0-9a-f]{64}$/);
  assert.equal((await fetch(otherBase + rejectedPath, {
    method: "PATCH", headers: manualHeaders, body: JSON.stringify({ decision: "reject" }),
  })).status, 200, "repeating a rejection is idempotent");
  assert.equal((await matchDb.prepare("", `SELECT decision_review_token FROM discovery_match_requests
    WHERE id=?`).get(rejectedId))?.decision_review_token, rejectedAudit?.decision_review_token);
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
  const beforeCandidatePages = await otherApp.archive.read();
  const pagedFamily = structuredClone(beforeCandidatePages.family);
  const template = pagedFamily.people.find((person) => person.id === "person-b")!;
  const pageIds = Array.from({ length: 25 }, (_, index) => `similar-${String(index).padStart(2, "0")}`);
  pagedFamily.people.push(...pageIds.map((id, index) => ({
    ...structuredClone(template), id, column: index + 2,
  })));
  const paged = await otherApp.archive.write(pagedFamily, beforeCandidatePages.revision);
  for (const id of pageIds)
    await otherPublication.publish(id, "owner", selectedDiscoveryFields);
  const candidatePath = "/api/discovery/matches/candidates?sourcePersonId=person-a";
  const firstCandidatePage = await fetch(securedBase + candidatePath, { headers: ownerHeaders }).then((response) => response.json());
  assert.equal(firstCandidatePage.candidates.length, 24);
  assert.equal(typeof firstCandidatePage.nextCursor, "string");
  const secondCandidatePage = await fetch(securedBase + candidatePath +
    `&cursor=${encodeURIComponent(firstCandidatePage.nextCursor)}`, { headers: ownerHeaders }).then((response) => response.json());
  assert.equal(secondCandidatePage.nextCursor, null);
  assert.equal(new Set([...firstCandidatePage.candidates, ...secondCandidatePage.candidates]
    .map((person: { id: string }) => person.id)).size, 26,
  "all published names remain reachable beyond the first indexed page");
  assert.equal((await fetch(securedBase + candidatePath + "&cursor=invalid", {
    headers: ownerHeaders,
  })).status, 400);
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('drevo.archive_id','other-archive',true)");
    await client.query(`INSERT INTO people(archive_id,id,ordinal,data)
      SELECT 'other-archive','load-'||g,
        (SELECT max(ordinal) FROM people WHERE archive_id='other-archive')+g,
        jsonb_build_object('id','load-'||g,'surname','Нагрузов','name','Даниил',
          'deceased',true,'birth','1900')
      FROM generate_series(1,600) AS g`);
    await client.query(`INSERT INTO published_people(archive_id,person_id,published_at,published_by)
      SELECT 'other-archive','load-'||g,'2026-01-01','owner'
      FROM generate_series(1,600) AS g`);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM discovery_people
      WHERE person_id LIKE 'load-%'`)).rows[0].count, 600);
    await client.query("SET LOCAL enable_seqscan=off");
    const fuzzyPlan = await client.query(`EXPLAIN (FORMAT JSON)
      SELECT person_id FROM discovery_people
      WHERE given_normalized % 'даниил' AND surname_normalized % 'нагрузов'`);
    assert.match(JSON.stringify(fuzzyPlan.rows), /discovery_people_(given|surname)_trgm/,
      "the typo branch has an executable trigram index plan with 600 published rows");
    const exactPlan = await client.query(`EXPLAIN (FORMAT JSON)
      SELECT person_id FROM discovery_people
      WHERE name_vector @@ to_tsquery('simple','нагрузов & даниил')`);
    assert.match(JSON.stringify(exactPlan.rows), /discovery_people_names/,
      "exact candidate names keep their GIN index path");
  } finally {
    await client.query("ROLLBACK");
  }
  await otherApp.archive.write(beforeCandidatePages.family, paged.revision);
  const ownBeforeSignals = await app.archive.read();
  const otherBeforeSignals = await otherApp.archive.read();
  const ownWithRelative = structuredClone(ownBeforeSignals.family);
  const otherWithRelative = structuredClone(otherBeforeSignals.family);
  const ownPerson = ownWithRelative.people.find((person) => person.id === "person-a")!;
  const otherPerson = otherWithRelative.people.find((person) => person.id === "person-a")!;
  ownPerson.birthPlace = "Россия, Свердловская область, Нижний Тагил";
  const parent = { ...structuredClone(ownPerson), id: "published-parent",
    surname: "Орлов", name: "Пётр", birth: "1960", deceased: true,
    parents: [], column: 50 };
  ownWithRelative.people.push(structuredClone(parent));
  otherWithRelative.people.push(structuredClone(parent));
  ownPerson.parents = [parent.id];
  otherWithRelative.people.push({ ...structuredClone(otherPerson),
    id: "relative-only", surname: "Сидоров", name: "Иван", birth: "1991",
    deceased: true, parents: [parent.id], spouses: ["closed-relative"], column: 51 });
  otherWithRelative.people.push({ ...structuredClone(otherPerson),
    id: "name-typo", surname: "Тестав", name: "Иван", deceased: true,
    parents: [], column: 52 });
  otherWithRelative.people.push({ ...structuredClone(otherPerson),
    id: "place-match", surname: "Петров", name: "Иван", birth: "1991",
    birthPlace: "Россия, Свердловская область, Нижний Тагил", deceased: true,
    parents: [], column: 54 });
  otherWithRelative.people.push({ ...structuredClone(otherPerson),
    id: "region-only", surname: "Романов", name: "Иван", birth: "1991",
    birthPlace: "Россия, Свердловская область, Екатеринбург", deceased: true,
    parents: [], column: 55 });
  otherWithRelative.people.push({ ...structuredClone(otherPerson),
    id: "closed-relative", surname: "Орлов", name: "Пётр", sex: "f", deceased: true,
    parents: [], spouses: ["relative-only"], column: 53 });
  const ownSignalWrite = await app.archive.write(ownWithRelative, ownBeforeSignals.revision);
  const otherSignalWrite = await otherApp.archive.write(otherWithRelative, otherBeforeSignals.revision);
  await otherPublication.publish("relative-only", "owner");
  await otherPublication.publish("name-typo", "owner");
  await otherPublication.publish("place-match", "owner");
  await otherPublication.publish("region-only", "owner");
  // Earlier scenarios deliberately spend the normal per-client search budget.
  const signalHeaders = { ...ownerHeaders, "X-Real-IP": "198.51.100.88" };
  const signalIds = async () => {
    const response = await fetch(securedBase + candidatePath, { headers: signalHeaders });
    assert.equal(response.status, 200, "the candidate page must be available to the owner");
    return (await response.json()).candidates as {
      id: string; reasons: string[]; conflicts: string[];
    }[];
  };
  assert.equal((await signalIds()).some((item) => item.id === "relative-only"), false,
    "a private relative cannot create a cross-archive hint");
  assert.ok((await signalIds()).some((item) => item.id === "name-typo" &&
    item.reasons.some((reason) => reason.includes("опечатка"))),
  "a typo in a published surname is found through the trigram index");
  assert.ok((await signalIds()).some((item) => item.id === "place-match" &&
    item.reasons.some((reason) => reason.includes("Место рождения"))),
  "the indexed place and year branch can suggest a changed surname");
  assert.equal((await signalIds()).some((item) => item.id === "region-only"), false,
    "a shared region without a shared settlement is not a candidate clue");
  await publishedPeopleStore(app.archive.db).publish(parent.id, "owner");
  await otherPublication.publish(parent.id, "owner");
  const revocableRequest = await fetch(securedBase + "/api/discovery/matches", {
    method: "POST", headers: manualHeaders,
    body: JSON.stringify({ sourcePersonId: parent.id, targetArchiveId: "other-archive",
      targetPersonId: parent.id }),
  });
  assert.equal(revocableRequest.status, 200);
  const revocableId = (await revocableRequest.json()).match.id as string;
  const revocablePath = `/api/discovery/matches/${revocableId}`;
  const revocableReview = (await (await fetch(otherBase + "/api/discovery/matches", {
    headers: manualHeaders,
  })).json()).matches.find((item: { id: string }) => item.id === revocableId);
  assert.ok(revocableReview?.reviewToken);
  assert.equal((await fetch(otherBase + revocablePath, {
    method: "PATCH", headers: manualHeaders,
    body: JSON.stringify({ decision: "accept", reviewToken: revocableReview.reviewToken }),
  })).status, 200);
  assert.equal((await fetch(securedBase + revocablePath, {
    method: "PATCH", headers: manualHeaders, body: JSON.stringify({ decision: "revoke" }),
  })).status, 200);
  assert.equal((await fetch(securedBase + revocablePath, {
    method: "PATCH", headers: manualHeaders, body: JSON.stringify({ decision: "revoke" }),
  })).status, 200, "repeating a revocation is idempotent");
  const revokedAudit = await matchDb.prepare("", `SELECT status,revoked_by,decision_review_token
    FROM discovery_match_requests WHERE id=?`).get(revocableId);
  assert.equal(revokedAudit?.status, "revoked");
  assert.equal(revokedAudit?.revoked_by, "owner");
  assert.equal(revokedAudit?.decision_review_token, revocableReview.reviewToken);
  assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count FROM discovery_linked_pairs
    WHERE left_person_id=? AND right_person_id=?`).get(parent.id,parent.id))?.count, 0,
  "manual revocation removes the public transition immediately");
  const relativeHint = (await signalIds()).find((item) => item.id === "relative-only");
  assert.ok(relativeHint?.reasons.includes("Совпадает опубликованный близкий родственник"));
  assert.doesNotMatch(JSON.stringify(relativeHint), /Пётр|Орлов|closed-relative/,
    "candidate evidence contains no relative names or private card identifiers");
  assert.equal((await app.archive.db.prepare("", `SELECT count(*)::int AS count
    FROM discovery_relative_names WHERE relative_person_id='closed-relative'`).get())?.count, 0);
  await otherPublication.unpublish(parent.id);
  assert.equal((await signalIds()).some((item) => item.id === "relative-only"), false,
    "revoking either parent publication removes the hint in the same transaction");
  assert.equal((await app.archive.db.prepare("", `SELECT count(*)::int AS count
    FROM discovery_relative_names WHERE relative_person_id='published-parent'
      AND archive_id='other-archive'`).get())?.count, 0);
  await app.archive.write(ownBeforeSignals.family, ownSignalWrite.revision);
  await otherApp.archive.write(otherBeforeSignals.family, otherSignalWrite.revision);
  await otherPublication.unpublish("person-a");
  await otherPublication.unpublish("person-b");
  assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
    FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'`).get())?.count, 0,
  "removing either publication revokes the extra-field grant in the same transaction");
  assert.equal((await fetch(securedBase + cardSharePath, { headers: ownerHeaders })).status, 404,
    "a revoked match cannot be used to read the old card snapshot");
  assert.deepEqual((await (await fetch(securedBase + "/api/discovery/people/runtime-test/person-a", {
    headers,
  })).json()).linkedCards, [], "revoking either publication removes the transition");
  assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count FROM discovery_linked_pairs
    WHERE left_archive_id='other-archive' AND right_archive_id='runtime-test'`).get())?.count, 0,
  "revocation removes the minimal public transition in the same transaction");
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
    assert.equal((await client.query("SELECT provider FROM account_oauth_session_proofs WHERE token_hash=$1", [sessionTokenHash(sessionCookie.slice("drevo_session=".length))])).rows[0]?.provider, "yandex");
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
    const portablePath = location.replace(/\/tree$/, "/api/drevo/export");
    const assertPortableTaskBlocked = async (
      taskName: string,
      request: () => Promise<Response>,
      expectedStatus: number,
    ) => {
      const secondProcess = await openPostgresDatabase(
        location.split("/")[2], source,
      );
      let entered!: () => void;
      let release!: () => void;
      const active = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const operation = secondProcess.withExclusiveArchiveTask!(
        taskName, async () => {
          entered();
          await held;
        },
      );
      void operation.then(entered, entered);
      try {
        await active;
        const response = await request();
        assert.equal(response.status, expectedStatus,
          `${taskName} must reject a concurrent request from another backend`);
        await response.body?.cancel();
      } finally {
        release();
        try {
          await operation;
        } finally {
          await secondProcess.close();
        }
      }
    };
    await assertPortableTaskBlocked(
      "portable-export",
      () => fetch(oauthBase + portablePath, {
        headers: { Cookie: sessionCookie },
      }),
      429,
    );
    const portable = await fetch(oauthBase + portablePath, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(portable.status, 200);
    assert.equal(Buffer.from(await portable.arrayBuffer()).subarray(0, 2).toString(), "PK");
    assert.notEqual(
      (await fetch(oauthBase + portablePath, { headers: ownerHeaders })).status,
      200,
      "another archive owner must not download this tree",
    );
    const importFile = join(directory, "portable-runtime.drevo");
    await writePortablePackage(createWriteStream(importFile), directory, {
      family: {
        title: "Transferred", description: "", demo: false,
        people: [{ id: "pg-portable-person", name: "Portable", surname: "Person",
          patronymic: "", sex: "u", birth: "1900", birthPlace: "",
          parents: [], spouses: [], generation: 1, column: 0, sources: [] }],
        photos: [],
      },
      documents: [],
      comments: [{ id: 1, personId: "pg-portable-person", authorId: "remote",
        authorName: "Historian", createdMs: 1000, text: "Verified" }],
    }, async () => {});
    const transferHeaders = {
      Cookie: sessionCookie,
      Origin: process.env.PUBLIC_ORIGIN!,
      "X-Drevo-Import": "1",
    };
    await assertPortableTaskBlocked(
      "portable-import",
      () => fetch(
        oauthBase + location.replace(/\/tree$/, "/api/drevo/preview"),
        { method: "POST", headers: transferHeaders, body: readFileSync(importFile) },
      ),
      409,
    );
    const overLimitFile = join(directory, "portable-over-limit.drevo");
    await writePortablePackage(createWriteStream(overLimitFile), directory, {
      family: {
        title: "Too many people", description: "", demo: false,
        people: Array.from({ length: 151 }, (_, index) => ({
          id: `pg-over-limit-${index}`, name: "Portable", surname: `Person ${index}`,
          patronymic: "", sex: "u" as const, birth: "1900", birthPlace: "",
          parents: [], spouses: [], generation: 1, column: index, sources: [],
        })),
        photos: [],
      },
      documents: [], comments: [],
    }, async () => {});
    const overLimitPreview = await fetch(oauthBase + location.replace(/\/tree$/, "/api/drevo/preview"), {
      method: "POST", headers: transferHeaders, body: readFileSync(overLimitFile),
    });
    assert.equal(overLimitPreview.status, 200,
      overLimitPreview.status === 200 ? "" : await overLimitPreview.text());
    const overLimitSummary = await overLimitPreview.json();
    assert.equal(overLimitSummary.canImport, false);
    assert.match(overLimitSummary.warning, /150/);
    const previewTransfer = await fetch(oauthBase + location.replace(/\/tree$/, "/api/drevo/preview"), {
      method: "POST", headers: transferHeaders, body: readFileSync(importFile),
    });
    assert.equal(previewTransfer.status, 200,
      previewTransfer.status === 200 ? "" : await previewTransfer.text());
    const transferSummary = await previewTransfer.json();
    assert.equal(transferSummary.canImport, true);
    const transferToken = transferSummary.token;
    const applyTransfer = () => fetch(oauthBase + location.replace(/\/tree$/, "/api/drevo/import"), {
      method: "POST", headers: { ...transferHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ token: transferToken, confirm: true }),
    });
    const imported = await applyTransfer();
    assert.equal(imported.status, 200,
      imported.status === 200 ? "" : await imported.text());
    assert.equal((await applyTransfer()).status, 409);
    const transferred = await fetch(oauthBase + location.replace(/\/tree$/, "/api/family"), {
      headers: { Cookie: sessionCookie },
    }).then((response) => response.json());
    assert.equal(transferred.family.people[0].id, "pg-portable-person");
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
    const personalArchiveId = location.split("/")[2];
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [
      personalArchiveId,
    ]);
    await client.query(
      "INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES($1,$2,'reader',true,'all')",
      [personalArchiveId, vkRegistration.accountId],
    );
    await client.query(
      "INSERT INTO accounts(id,name,created_at) VALUES('transfer-target','New owner',$1)",
      [new Date().toISOString()],
    );
    await client.query(
      "INSERT INTO account_tiers(account_id,full_access) VALUES('transfer-target',false)",
    );
    await client.query(
      "INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES($1,'transfer-target','reader',true,'all')",
      [personalArchiveId],
    );
    const newOwnerToken = newSessionToken();
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'transfer-target',$2)",
      [sessionTokenHash(newOwnerToken), Date.now() + 10 * 60_000],
    );
    const ownerTransferPath = location.replace(
      /\/tree$/,
      "/api/account/owner-transfer",
    );
    const transferOwnerHeaders = {
      Cookie: sessionCookie,
      Origin: process.env.PUBLIC_ORIGIN!,
      "Content-Type": "application/json",
      "X-Drevo-Owner-Transfer": "1",
    };
    const transferTargetHeaders = {
      ...transferOwnerHeaders,
      Cookie: `drevo_session=${newOwnerToken}`,
    };
    const candidates = await fetch(
      oauthBase + ownerTransferPath + "/candidates",
      {
        headers: transferOwnerHeaders,
      },
    ).then((response) => response.json());
    assert.ok(
      candidates.some(
        (candidate: { id: string; eligible: boolean }) =>
          candidate.id === "transfer-target" && candidate.eligible,
      ),
    );
    assert.ok(
      candidates.some(
        (candidate: { id: string; eligible: boolean }) =>
          candidate.id === vkRegistration.accountId && !candidate.eligible,
      ),
    );
    assert.equal(
      (
        await fetch(oauthBase + ownerTransferPath, {
          method: "POST",
          headers: transferOwnerHeaders,
          body: JSON.stringify({ targetId: vkRegistration.accountId }),
        })
      ).status,
      409,
      "a current owner cannot own a second tree",
    );
    assert.equal(
      (
        await fetch(oauthBase + ownerTransferPath, {
          method: "POST",
          headers: transferTargetHeaders,
          body: JSON.stringify({ targetId: vkRegistration.accountId }),
        })
      ).status,
      403,
      "a member cannot initiate ownership transfer",
    );
    assert.equal(
      (
        await fetch(oauthBase + ownerTransferPath, {
          method: "POST",
          headers: { ...transferOwnerHeaders, Origin: "https://other.test" },
          body: JSON.stringify({ targetId: "transfer-target" }),
        })
      ).status,
      403,
      "cross-origin ownership proposals are rejected",
    );
    await client.query(
      `INSERT INTO documents(archive_id,id,ordinal,title,title_search,file_name,file_size,uploaded_by,created_at)
       VALUES($1,'transfer-quota-check',(SELECT COALESCE(max(ordinal),0)+1 FROM documents WHERE archive_id=$1),
         'Quota check','quota check','transfer-quota-check.pdf',500000001,$2,$3)`,
      [personalArchiveId, newAccountSession.user.id, new Date().toISOString()],
    );
    assert.equal(
      (
        await fetch(oauthBase + ownerTransferPath, {
          method: "POST",
          headers: transferOwnerHeaders,
          body: JSON.stringify({ targetId: "transfer-target" }),
        })
      ).status,
      409,
      "a basic recipient cannot inherit an over-quota tree",
    );
    await client.query(
      "DELETE FROM documents WHERE archive_id=$1 AND id='transfer-quota-check'",
      [personalArchiveId],
    );
    const proposedOwner = await fetch(oauthBase + ownerTransferPath, {
      method: "POST",
      headers: transferOwnerHeaders,
      body: JSON.stringify({ targetId: "transfer-target" }),
    });
    assert.equal(
      proposedOwner.status,
      200,
      proposedOwner.status === 200 ? "" : await proposedOwner.text(),
    );
    assert.equal(
      (
        await fetch(oauthBase + ownerTransferPath, {
          method: "DELETE",
          headers: transferTargetHeaders,
        })
      ).status,
      200,
      "the recipient can decline the offer",
    );
    assert.equal(
      (
        await fetch(oauthBase + ownerTransferPath + "/accept", {
          method: "POST",
          headers: transferTargetHeaders,
        })
      ).status,
      409,
      "a declined offer cannot be accepted",
    );
    assert.equal(
      (
        await fetch(oauthBase + ownerTransferPath, {
          method: "POST",
          headers: transferOwnerHeaders,
          body: JSON.stringify({ targetId: "transfer-target" }),
        })
      ).status,
      200,
    );
    const incomingTransfer = await fetch(oauthBase + ownerTransferPath, {
      headers: transferTargetHeaders,
    }).then((response) => response.json());
    assert.ok(incomingTransfer.incoming?.fromName);
    const acceptedOwner = await fetch(
      oauthBase + ownerTransferPath + "/accept",
      {
        method: "POST",
        headers: transferTargetHeaders,
      },
    );
    assert.equal(
      acceptedOwner.status,
      200,
      acceptedOwner.status === 200 ? "" : await acceptedOwner.text(),
    );
    assert.equal(
      (
        await fetch(oauthBase + ownerTransferPath + "/accept", {
          method: "POST",
          headers: transferTargetHeaders,
        })
      ).status,
      409,
      "acceptance is one-use",
    );
    assert.equal(
      (
        await client.query(
          "SELECT user_id FROM archive_owners WHERE archive_id=$1",
          [personalArchiveId],
        )
      ).rows[0]?.user_id,
      "transfer-target",
    );
    const transferRoles = (
      await client.query(
        "SELECT user_id,role FROM archive_memberships WHERE archive_id=$1 AND user_id IN ('transfer-target',$2)",
        [personalArchiveId, newAccountSession.user.id],
      )
    ).rows;
    assert.equal(
      transferRoles.find((row) => row.user_id === "transfer-target")?.role,
      "admin",
    );
    assert.equal(
      transferRoles.find((row) => row.user_id === newAccountSession.user.id)
        ?.role,
      "relative",
    );
    const deletionPath = location.replace(/\/tree$/, "/api/account/archive-deletion");
    assert.equal((await fetch(oauthBase + deletionPath, {
      headers: transferOwnerHeaders,
    })).status, 403, "the previous owner cannot delete the archive");
    const deletionPlanResponse = await fetch(oauthBase + deletionPath, {
      headers: transferTargetHeaders,
    });
    assert.equal(deletionPlanResponse.status, 200);
    const deletionPlan = await deletionPlanResponse.json();
    assert.ok(deletionPlan.otherMembers >= 1);
    const deletionHeaders = {
      ...transferTargetHeaders,
      "X-Drevo-Archive-Deletion": "1",
    };
    assert.equal((await fetch(oauthBase + deletionPath, {
      method: "DELETE",
      headers: { ...deletionHeaders, Origin: "https://other.test" },
      body: JSON.stringify({ title: deletionPlan.title, removeCollaborators: true }),
    })).status, 403);
    assert.equal((await fetch(oauthBase + deletionPath, {
      method: "DELETE",
      headers: deletionHeaders,
      body: JSON.stringify({ title: "Wrong name", removeCollaborators: true }),
    })).status, 409);
    assert.equal((await fetch(oauthBase + deletionPath, {
      method: "DELETE",
      headers: deletionHeaders,
      body: JSON.stringify({ title: deletionPlan.title, removeCollaborators: false }),
    })).status, 409);
    const deletedArchive = await fetch(oauthBase + deletionPath, {
      method: "DELETE",
      headers: deletionHeaders,
      body: JSON.stringify({ title: deletionPlan.title, removeCollaborators: true }),
    });
    assert.equal(deletedArchive.status, 200,
      deletedArchive.status === 200 ? "" : await deletedArchive.text());
    assert.equal((await deletedArchive.json()).filesRemoved, true);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM archives WHERE id=$1", [personalArchiveId])).rows[0].n, 0);
    assert.equal(existsSync(join(dirname(source), "archives", personalArchiveId)), false);
    assert.equal((await fetch(oauthBase + location.replace(/\/tree$/, "/api/session"), {
      headers: transferTargetHeaders,
    })).status, 404, "deleted archive cannot be reopened through a warm route");
    const sessionAfterArchiveDeletion = await fetch(oauthBase + "/api/session", {
      headers: transferTargetHeaders,
    }).then((response) => response.json());
    assert.equal(sessionAfterArchiveDeletion.account.id, "transfer-target",
      "deleting one archive must not delete the account or its session");
    const createArchiveHeaders = {
      ...transferTargetHeaders,
      "X-Drevo-New-Archive": "1",
    };
    assert.equal((await fetch(oauthBase + "/api/account/archives", {
      method: "POST",
      headers: { ...createArchiveHeaders, Origin: "https://other.test" },
    })).status, 403);
    const recreatedResponse = await fetch(oauthBase + "/api/account/archives", {
      method: "POST",
      headers: createArchiveHeaders,
    });
    assert.equal(recreatedResponse.status, 201,
      recreatedResponse.status === 201 ? "" : await recreatedResponse.text());
    const recreatedId = (await recreatedResponse.json()).archiveId;
    assert.notEqual(recreatedId, personalArchiveId);
    assert.equal((await fetch(oauthBase + "/api/account/archives", {
      method: "POST", headers: createArchiveHeaders,
    })).status, 409, "a repeated create request cannot make a second owned tree");
    assert.equal((await fetch(oauthBase + `/a/${recreatedId}/api/session`, {
      headers: transferTargetHeaders,
    })).status, 200);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [recreatedId]);
    await client.query(
      "INSERT INTO accounts(id,name,created_at) VALUES('deleting-account','Delete me',$1)",
      [new Date().toISOString()],
    );
    await client.query(
      "INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES($1,'deleting-account','reader',true,'all')",
      [recreatedId],
    );
    const deletingToken = newSessionToken();
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'deleting-account',$2)",
      [sessionTokenHash(deletingToken), Date.now() + 600_000],
    );
    await client.query(
      "INSERT INTO ai_chats(archive_id,id,user_id,access_scope) VALUES($1,'delete-chat','deleting-account','all')",
      [recreatedId],
    );
    await client.query(
      "INSERT INTO archive_audit_entries(archive_id,id,at,actor_id,actor_name,action,entity,entity_id,label,details) VALUES($1,987654,$2,'deleting-account','Delete me','update','archive',$1,'Test','[]'::jsonb)",
      [recreatedId, new Date().toISOString()],
    );
    await client.query(
      "INSERT INTO archive_invitations(archive_id,id,token_hash,role,created_by,created_at,expires_at) VALUES($1,'10000000-0000-4000-8000-000000000001','account-delete-invite','reader','deleting-account',$2,$3)",
      [recreatedId, new Date().toISOString(), new Date(Date.now() + 600_000).toISOString()],
    );
    await client.query(
      "INSERT INTO archive_owner_transfers(archive_id,from_user_id,to_user_id,created_ms,expires_ms) VALUES($1,'transfer-target','deleting-account',$2,$3)",
      [recreatedId, Date.now(), Date.now() + 600_000],
    );
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await client.query(
      "INSERT INTO person_comments(id,person_id,author_id,author_name,created_ms,text) VALUES(987659,'person-a','deleting-account','Delete me',$1,'Own comment in former tree'),(987660,'person-a','owner','Owner',$1,'Other author remains')",
      [Date.now()],
    );
    await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
    await client.query(
      "INSERT INTO person_comments(id,person_id,author_id,author_name,created_ms,text) VALUES(987661,'person-a','deleting-account','Delete me',$1,'Own comment in another former tree')",
      [Date.now()],
    );
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [recreatedId]);
    const accountDeletionPath = "/api/account/deletion";
    const deletingHeaders = {
      Cookie: `drevo_session=${deletingToken}`,
      "Content-Type": "application/json",
      "X-Drevo-Account-Deletion": "1",
    };
    const accountDeletionPlan = await fetch(oauthBase + accountDeletionPath, {
      headers: deletingHeaders,
    }).then((response) => response.json());
    assert.equal(accountDeletionPlan.name, "Delete me");
    assert.equal(accountDeletionPlan.ownedArchives, 0);
    assert.equal(accountDeletionPlan.sharedArchives, 1);
    assert.equal(accountDeletionPlan.canRedactComments, true);
    assert.equal((await fetch(oauthBase + accountDeletionPath, {
      method: "DELETE", headers: { ...deletingHeaders, Origin: "https://other.test" },
      body: JSON.stringify({ name: "Delete me", leaveSharedArchives: true }),
    })).status, 403);
    assert.equal((await fetch(oauthBase + accountDeletionPath, {
      method: "DELETE", headers: deletingHeaders,
      body: JSON.stringify({ name: "Wrong", leaveSharedArchives: true }),
    })).status, 409);
    assert.equal((await fetch(oauthBase + accountDeletionPath, {
      method: "DELETE", headers: deletingHeaders,
      body: JSON.stringify({ name: "Delete me", leaveSharedArchives: false }),
    })).status, 409);
    const ownerAccountPlan = await fetch(oauthBase + accountDeletionPath, {
      headers: transferTargetHeaders,
    }).then((response) => response.json());
    assert.equal(ownerAccountPlan.ownedArchives, 1);
    assert.equal((await fetch(oauthBase + accountDeletionPath, {
      method: "DELETE", headers: { ...transferTargetHeaders, "X-Drevo-Account-Deletion": "1" },
      body: JSON.stringify({ name: ownerAccountPlan.name, leaveSharedArchives: true }),
    })).status, 409, "an owner must transfer or remove their tree first");
    await client.query("BEGIN");
    await client.query("SELECT set_config('drevo.account_id','owner',true)");
    await client.query("INSERT INTO deleted_account_tombstones(id,redact_comments) VALUES('deleting-account',true)");
    await assert.rejects(
      client.query("SELECT public.runtime_redact_deleted_account_comments('deleting-account')"),
      /Account comment redaction context is missing/,
      "the privileged function rejects another account's transaction context",
    );
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("SELECT set_config('drevo.account_id','deleting-account',true)");
    await client.query("INSERT INTO deleted_account_tombstones(id,redact_comments) VALUES('deleting-account',true)");
    const firstRedaction = await client.query("SELECT public.runtime_redact_deleted_account_comments('deleting-account') AS count");
    assert.equal(Number(firstRedaction.rows[0].count), 2);
    const repeatedRedaction = await client.query("SELECT public.runtime_redact_deleted_account_comments('deleting-account') AS count");
    assert.equal(Number(repeatedRedaction.rows[0].count), 2, "repeating cleanup changes no text further");
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',true)");
    assert.equal((await client.query("SELECT text FROM person_comments WHERE id=987659")).rows[0].text,
      "Текст удалён по запросу автора");
    await client.query("SELECT set_config('drevo.archive_id','other-archive',true)");
    assert.equal((await client.query("SELECT text FROM person_comments WHERE id=987661")).rows[0].text,
      "Текст удалён по запросу автора", "privileged cleanup crosses archives without using the request archive");
    await client.query("ROLLBACK");
    const commentWriter = new pg.Client();
    await commentWriter.connect();
    let removedAccount: Response;
    try {
      await commentWriter.query("BEGIN");
      await commentWriter.query("SELECT set_config('drevo.archive_id','other-archive',true)");
      await commentWriter.query(
        "INSERT INTO person_comments(id,person_id,author_id,author_name,created_ms,text) VALUES(987662,'person-a','deleting-account','Delete me',$1,'In-flight own comment')",
        [Date.now()],
      );
      let deletionSettled = false;
      const deletionRequest = fetch(oauthBase + accountDeletionPath, {
        method: "DELETE", headers: deletingHeaders,
        body: JSON.stringify({ accountId: "owner", name: "Delete me", leaveSharedArchives: true, redactComments: true }),
      }).then((response) => { deletionSettled = true; return response; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(deletionSettled, false, "deletion waits for an in-flight comment by the same account");
      await commentWriter.query("COMMIT");
      removedAccount = await deletionRequest;
    } finally {
      await commentWriter.query("ROLLBACK").catch(() => {});
      await commentWriter.end();
    }
    assert.equal(removedAccount.status, 200,
      removedAccount.status === 200 ? "" : await removedAccount.text());
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    assert.deepEqual((await client.query("SELECT author_id,text FROM person_comments WHERE id=987659")).rows[0],
      { author_id: "deleted-account", text: "Текст удалён по запросу автора" });
    assert.equal((await client.query("SELECT text FROM person_comments WHERE id=987660")).rows[0].text,
      "Other author remains", "a spoofed accountId cannot redact another author's comment");
    await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
    assert.deepEqual((await client.query("SELECT author_id,text FROM person_comments WHERE id=987661")).rows[0],
      { author_id: "deleted-account", text: "Текст удалён по запросу автора" },
      "comments in another archive left before deletion are redacted");
    assert.equal((await client.query("SELECT text FROM person_comments WHERE id=987662")).rows[0].text,
      "Текст удалён по запросу автора", "in-flight comment is redacted before deletion commits");
    await client.query(
      "INSERT INTO person_comments(id,person_id,author_id,author_name,created_ms,text) VALUES(987663,'person-a','deleting-account','Delete me',$1,'Late own comment')",
      [Date.now()],
    );
    assert.deepEqual((await client.query("SELECT author_id,text FROM person_comments WHERE id=987663")).rows[0],
      { author_id: "deleted-account", text: "Текст удалён по запросу автора" },
      "a stale writer cannot add unredacted text after account deletion");
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [recreatedId]);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM accounts WHERE id='deleting-account'")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM archive_memberships WHERE user_id='deleting-account'")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM ai_chats WHERE user_id='deleting-account'")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM archive_invitations WHERE created_by='deleting-account'")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM archive_owner_transfers WHERE to_user_id='deleting-account'")).rows[0].n, 0);
    assert.deepEqual((await client.query("SELECT actor_id,actor_name FROM archive_audit_entries WHERE archive_id=$1 AND id=987654", [recreatedId])).rows[0],
      { actor_id: "deleted-account", actor_name: "Удалённый участник" });
    assert.equal((await fetch(oauthBase + accountDeletionPath, { headers: deletingHeaders })).status, 401);
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await client.query(
      "INSERT INTO accounts(id,name,created_at) VALUES('former-member','Former member',$1)",
      [new Date().toISOString()],
    );
    await client.query(
      "INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES('runtime-test','former-member','reader',true,'all')",
    );
    await client.query(
      "INSERT INTO archive_audit_entries(archive_id,id,at,actor_id,actor_name,action,entity,entity_id,label,details) VALUES('runtime-test',987655,$1,'former-member','Former member','update','archive','runtime-test','History','[]'::jsonb)",
      [new Date().toISOString()],
    );
    await client.query(
      `INSERT INTO archive_audit_entries(archive_id,id,at,actor_id,actor_name,action,entity,entity_id,label,details)
       VALUES('runtime-test',987657,$1,'owner','Owner','Передано владение деревом','user','former-member','Former member',
         '[{"field":"Владелец","before":"former-member","after":"owner"}]'::jsonb)`,
      [new Date().toISOString()],
    );
    await client.query(
      "INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text) VALUES('person-a','former-member','Former member',$1,'Historical comment')",
      [Date.now()],
    );
    const oldShareToken = "A".repeat(43);
    const oldMcpToken = `drevo_mcp_${"B".repeat(43)}`;
    const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
    await client.query(
      `INSERT INTO share_links(id,token_hash,title,anchor_id,person_ids,created_at,expires_at,created_by,created_name)
       VALUES('former-share',$1,'Former link','person-a','["person-a"]'::jsonb,$2,$3,'former-member','Former member')`,
      [tokenHash(oldShareToken), new Date().toISOString(), new Date(Date.now() + 600_000).toISOString()],
    );
    await client.query(
      `INSERT INTO mcp_tokens(id,token_hash,token_hint,name,scopes,created_at,created_by)
       VALUES('former-mcp',$1,'old','Former token','["tree:read"]'::jsonb,$2,'former-member')`,
      [tokenHash(oldMcpToken), new Date().toISOString()],
    );
    await client.query(
      `INSERT INTO research_suggestions(id,kind,status,person_id,payload,reason,evidence,base_revision,created_at,created_by)
       VALUES('former-suggestion','person_update','accepted','person-a','{}'::jsonb,'History','[]'::jsonb,0,$1,'former-member')`,
      [new Date().toISOString()],
    );
    await client.query("UPDATE people SET data=jsonb_set(data,'{createdBy}',to_jsonb('former-member'::text)) WHERE id='person-a'");
    await client.query(
      `INSERT INTO history(archive_id,revision,saved_at,data) VALUES
       ('runtime-test',987656,$1,'{"people":[{"id":"person-a","createdBy":"former-member","name":"Preserved"}],"photos":[],"links":[]}'::jsonb)`,
      [new Date().toISOString()],
    );
    await client.query("BEGIN");
    await client.query("SELECT set_config('drevo.account_id','former-member',true)");
    await client.query("INSERT INTO deleted_account_tombstones(id) VALUES('former-member')");
    await client.query("SELECT public.runtime_anonymize_deleted_account_history('former-member')");
    const once = (await client.query("SELECT data FROM history WHERE revision=987656")).rows[0].data;
    await client.query("SELECT public.runtime_anonymize_deleted_account_history('former-member')");
    assert.deepEqual((await client.query("SELECT data FROM history WHERE revision=987656")).rows[0].data, once,
      "a repeated cleanup does not change the historical snapshot again");
    await client.query("ROLLBACK");
    await client.query(
      "DELETE FROM archive_memberships WHERE archive_id='runtime-test' AND user_id='former-member'",
    );
    const formerToken = newSessionToken();
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'former-member',$2)",
      [sessionTokenHash(formerToken), Date.now() + 600_000],
    );
    const formerDeletion = await fetch(oauthBase + accountDeletionPath, {
      method: "DELETE",
      headers: { Cookie: `drevo_session=${formerToken}`, "Content-Type": "application/json", "X-Drevo-Account-Deletion": "1" },
      body: JSON.stringify({ name: "Former member", leaveSharedArchives: false }),
    });
    assert.equal(formerDeletion.status, 200,
      formerDeletion.status === 200 ? "" : await formerDeletion.text());
    assert.deepEqual((await client.query("SELECT actor_id,actor_name FROM archive_audit_entries WHERE id=987655")).rows[0],
      { actor_id: "deleted-account", actor_name: "Удалённый участник" },
      "a former member's historical attribution is physically anonymized");
    const userAudit = (await client.query("SELECT actor_id,entity_id,label,details FROM archive_audit_entries WHERE id=987657")).rows[0];
    assert.equal(userAudit.actor_id, "owner");
    assert.equal(userAudit.entity_id, "deleted-account");
    assert.equal(userAudit.label, "Удалённый участник");
    assert.deepEqual(userAudit.details, [{ field: "Владелец", before: "deleted-account", after: "owner" }]);
    assert.deepEqual((await client.query("SELECT author_id,author_name FROM person_comments WHERE text='Historical comment'")).rows[0],
      { author_id: "deleted-account", author_name: "Удалённый участник" });
    assert.equal((await client.query("SELECT created_by FROM research_suggestions WHERE id='former-suggestion'")).rows[0].created_by, "deleted-account");
    assert.equal((await client.query("SELECT data->>'createdBy' AS creator FROM people WHERE id='person-a'")).rows[0].creator, "deleted-account");
    const historicalSnapshot = (await client.query("SELECT revision,data FROM history WHERE revision=987656")).rows[0];
    assert.equal(historicalSnapshot.revision, "987656");
    assert.deepEqual(historicalSnapshot.data, {
      people: [{ id: "person-a", createdBy: "deleted-account", name: "Preserved" }], photos: [], links: [],
    });
    const oldShare = (await client.query("SELECT created_by,created_name,revoked_at FROM share_links WHERE id='former-share'")).rows[0];
    assert.equal(oldShare.created_by, "deleted-account");
    assert.equal(oldShare.created_name, "Удалённый участник");
    assert.ok(oldShare.revoked_at);
    const oldMcp = (await client.query("SELECT created_by,revoked_at FROM mcp_tokens WHERE id='former-mcp'")).rows[0];
    assert.equal(oldMcp.created_by, "deleted-account");
    assert.ok(oldMcp.revoked_at);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [recreatedId]);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM archive_audit_entries WHERE id=987655")).rows[0].n, 0,
      "RLS still hides another archive after account deletion");
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    assert.equal((await client.query("SELECT actor_name FROM runtime_visible_audit_entries WHERE id=987655")).rows[0].actor_name, "Удалённый участник");
    assert.equal((await client.query("SELECT author_name FROM runtime_visible_person_comments WHERE text='Historical comment'")).rows[0].author_name, "Удалённый участник");
    const visibleComments = await fetch(securedBase + "/api/people/person-a/discussion", {
      headers: ownerHeaders,
    }).then((response) => response.json());
    assert.equal(visibleComments.items.find((item: { text: string }) => item.text === "Historical comment")?.author, "Удалённый участник");
    assert.equal((await client.query("SELECT created_by FROM runtime_visible_research_suggestions WHERE id='former-suggestion'")).rows[0].created_by, "deleted-account");
    assert.equal((await sharesStore(app.archive.db).get(oldShareToken)), null,
      "a share created by a former member stops working when their account is deleted");
    assert.equal(await publicShareAccess(app.archive.db)("runtime-test", oldShareToken), false,
      "a deleted creator cannot use a share to open the archive runtime");
    assert.equal((await mcpTokenStore(app.archive.db).authenticate(`Bearer ${oldMcpToken}`)), null,
      "an unbound MCP token from a deleted account stops working");
    assert.equal((await auditStore(app.archive.db).list({ before: 987656 })).items.find((entry) => entry.id === 987655)?.actorName, "Удалённый участник");
    const portableAfterDeletion = await fetch(securedBase + "/api/drevo/export", { headers: ownerHeaders });
    assert.equal(portableAfterDeletion.status, 200);
    const portableAfterDeletionPath = join(directory, "after-account-deletion.drevo");
    writeFileSync(portableAfterDeletionPath, Buffer.from(await portableAfterDeletion.arrayBuffer()));
    const portableZip = await openPromise(portableAfterDeletionPath);
    let portableComments: Array<{ text: string; authorId: string; authorName: string }> = [];
    for await (const entry of portableZip.eachEntry()) {
      if (entry.fileName !== "archive.json") continue;
      const chunks: Buffer[] = [];
      for await (const chunk of await portableZip.openReadStreamPromise(entry)) chunks.push(Buffer.from(chunk));
      portableComments = JSON.parse(Buffer.concat(chunks).toString()).comments;
    }
    const historicalPortableComment = portableComments.find((comment) => comment.text === "Historical comment");
    assert.equal(historicalPortableComment?.authorId, "deleted-account");
    assert.equal(historicalPortableComment?.authorName, "Удалённый участник");
    await client.query(
      "SELECT set_config('drevo.archive_id','runtime-test',false)",
    );
  } finally {
    await oauthApp.close();
    if (originalClientId === undefined) delete process.env.YANDEX_CLIENT_ID;
    else process.env.YANDEX_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.YANDEX_CLIENT_SECRET;
    else process.env.YANDEX_CLIENT_SECRET = originalClientSecret;
  }
  await verifyEmailAccounts(app.archive.db, client);
  // Audit provenance and undo stay inside the selected archive under non-superuser RLS.
  const beforeBatch = await app.archive.read();
  const batchPlan = planAdditions(beforeBatch.family, {
    format: "drevo.reviewed-add-only", version: 1,
    newPeople: [{ id: "pg-import-only", name: "Импорт", surname: "Проверка" }],
  }, "owner");
  const addedBatch = await app.archive.write(batchPlan.family, beforeBatch.revision, undefined, "import_additions");
  assert.equal((await listAdditionBatches(app.archive.db))[0].count, 1);
  assert.equal((await listAdditionBatches(otherApp.archive.db)).length, 0);
  await assert.rejects(planUndoAdditions(otherApp.archive.db, (await otherApp.archive.read()).family, addedBatch.revision), /не найден/);
  const undoBatch = await planUndoAdditions(app.archive.db, addedBatch.family, addedBatch.revision);
  assert.equal(undoBatch.preview.errorCount, 0);
  assert.deepEqual(undoBatch.family, beforeBatch.family);
  await app.archive.write(undoBatch.family, addedBatch.revision, undefined, undefined, addedBatch.family, undefined,
    (db) => auditStore(db).record({ action: "undo_import_additions", entity: "archive", entityId: `import:${addedBatch.revision}`, label: "Отмена импорта", personIds: [], details: [] }, undefined, addedBatch.revision + 1));
  assert.equal((await listAdditionBatches(app.archive.db))[0].undone, true);
  await assert.rejects(planUndoAdditions(app.archive.db, beforeBatch.family, addedBatch.revision), /уже отменён/);
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
