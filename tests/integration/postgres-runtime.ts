import { readStorageLimits, writeStorageLimits, enforceUserStorageLimit } from "../../src/server/storage-limits.ts";
import { DEFAULT_STORAGE_LIMITS } from "../../src/shared/storage-limits.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { vkAuthSettingsStore } from "../../src/server/vk-auth-settings.ts";
import { createWriteStream, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { openPromise } from "yauzl";
import {
  newSessionToken,
  sessionTokenHash,
} from "../../src/server/session-token.ts";
import { openPostgresDatabase } from "../../src/server/store-database.ts";
import { initializePostgresRuntimeSchema } from "../../src/server/postgres-runtime-schema.ts";
import { backupCoordinator } from "../../src/server/backup-coordinator.ts";
import { databaseBackupHttp } from "../../src/server/database-backup-http.ts";
import { createAuth } from "../../src/server/auth.ts";
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
import { aiResearchHttp } from "../../src/server/ai-research-http.ts";
import { accountAiAccess } from "../../src/server/account-ai-access.ts";
import { researchSuggestionStore } from "../../src/server/research-suggestions.ts";
import { researchCatalogStore } from "../../src/server/research-catalog.ts";
import { mediaStore } from "../../src/server/media.ts";
import { documentsHttp } from "../../src/server/documents-http.ts";
import { personDiscussionHttp } from "../../src/server/person-discussion-http.ts";
import { discussionAttachmentStore, prepareCommentFile } from "../../src/server/discussion-attachments.ts";
import { sampleTiff } from "../fixtures/tiff.ts";
import { imagePreviews } from "../../src/server/image-previews.ts";
import { accountCapacity } from "../../src/server/account-capacity.ts";
import { accountDataExport } from "../../src/server/account-data-export.ts";
import { accountSelfDeletion } from "../../src/server/account-self-deletion.ts";
import { accountSelfDeletionHttp } from "../../src/server/account-self-deletion-http.ts";
import { accountDataExportHttp } from "../../src/server/account-data-export-http.ts";
import { gedcomHttp } from "../../src/server/gedcom-http.ts";
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
import { restoreStore } from "../../src/server/restore.ts";
import { startServer } from "../../src/server/index.ts";
import { adaptLegacyAiFake } from "../legacy-ai-fake.ts";
import {
  BASIC_MEDIA_BYTES,
  enforcePostgresMediaQuota,
  releaseAttachedMediaGrants,
} from "../../src/server/postgres-media-quota.ts";
import { uploadQuota, UploadQuotaError } from "../../src/server/upload-quota.ts";
import { archiveChanges } from "../../src/domain/changes.ts";
import { sourceCatalogStore } from "../../src/server/source-catalog-store.ts";
import { sourceCitation } from "../../src/shared/source-catalog.ts";
import { reservePlatformDisk } from "../../src/server/platform-disk-reservation.ts";
import { registerMediaUpload } from "../../src/server/media-access.ts";
import type { Family } from "../../src/domain/types.ts";
import { planAdditions } from "../../src/domain/additions-import.ts";
import { listAdditionBatches, planUndoAdditions } from "../../src/server/additions-undo.ts";
import { auditStore } from "../../src/server/audit.ts";
import { writePortablePackage } from "../../src/server/portable-package.ts";
import { portableExportHttp } from "../../src/server/portable-http.ts";
import { portableImportHttp } from "../../src/server/portable-import-http.ts";
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
let restoreGuardApp: Awaited<ReturnType<typeof startServer>> | undefined;
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
  assert.equal((await client.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='runtime_visible_person_comments'
      AND column_name='updated_ms'`)).rowCount, 1,
  "the clean PostgreSQL runtime applies person comment schema 053 before grant schema 054");
  assert.equal((await client.query("SELECT to_regclass('discovery_linked_card_grants') AS name")).rows[0].name,
    "discovery_linked_card_grants");
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='discovery_linked_card_grants'
      AND column_name='expires_at'`)).rows[0].count, 1,
  "a clean database applies finite card consent schema 063 after 054");
  assert.equal((await client.query("SELECT to_regclass('discovery_branch_members') AS name")).rows[0].name,
    "discovery_branch_members", "a clean database applies branch grant schema 055");
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='discovery_branch_grants'
      AND column_name='expires_at'`)).rows[0].count, 1,
  "a clean database applies finite branch consent schema 062 after 055");
  await client.query("DROP TABLE discovery_branch_members");
  await client.query("DROP TABLE discovery_branch_grants");
  await initializePostgresRuntimeSchema(live.db);
  assert.equal((await client.query(`SELECT relforcerowsecurity FROM pg_class
    WHERE oid=to_regclass('discovery_branch_members')`)).rows[0]?.relforcerowsecurity,
  true, "upgrading schema 054 installs the FORCE RLS branch projection as 055");
  assert.match((await client.query(`SELECT qual FROM pg_policies WHERE schemaname=current_schema()
    AND tablename='discovery_branch_members' AND policyname='discovery_branch_members_read'`))
    .rows[0]?.qual || "", /expires_at/,
  "reinstalling 055 also restores the active-consent RLS gate as 062");
  assert.match((await client.query(`SELECT qual FROM pg_policies WHERE schemaname=current_schema()
    AND tablename='discovery_branch_grants' AND policyname='discovery_branch_grants_read'`))
    .rows[0]?.qual || "", /expires_at/,
  "reinstalling 055 also closes expired grant metadata to recipients as 064");
  await client.query(readFileSync(new URL("../../ops/postgres/055_discovery_branch_grants.sql", import.meta.url), "utf8"));
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM pg_policies
    WHERE schemaname=current_schema() AND tablename IN
      ('discovery_branch_grants','discovery_branch_members')
      AND policyname LIKE 'discovery_branch_%'`)).rows[0].count, 7);
  await client.query("DROP TABLE discovery_linked_card_grants");
  await initializePostgresRuntimeSchema(live.db);
  assert.equal((await client.query(`SELECT relforcerowsecurity FROM pg_class
    WHERE oid=to_regclass('discovery_linked_card_grants')`)).rows[0]?.relforcerowsecurity,
  true, "upgrading a database at schema 053 installs the FORCE RLS grant table as 054");
  assert.match((await client.query(`SELECT qual FROM pg_policies WHERE schemaname=current_schema()
    AND tablename='discovery_linked_card_grants' AND policyname='discovery_linked_card_read'`))
    .rows[0]?.qual || "", /expires_at/,
  "reinstalling 054 also restores the active-consent RLS gate as 063");
  await client.query(readFileSync(new URL("../../ops/postgres/054_discovery_linked_card_grants.sql", import.meta.url), "utf8"));
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM pg_policies
    WHERE schemaname=current_schema() AND tablename='discovery_linked_card_grants'
      AND policyname IN ('discovery_linked_card_read','discovery_linked_card_insert',
        'discovery_linked_card_update','discovery_linked_card_delete')`)).rows[0].count,
  4, "a repeated 054 migration keeps all four access policies exactly once");
  assert.equal((await client.query(`SELECT relforcerowsecurity FROM pg_class
    WHERE oid=to_regclass('discovery_copied_fields')`)).rows[0]?.relforcerowsecurity,
  true, "a clean database installs recipient-only transfer provenance as 061");
  assert.equal((await client.query(`SELECT count(*)::int AS count
    FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='relations' AND column_name='sources'`)).rows[0].count,
  1, "a clean database applies family link sources 060 before copy provenance 061");
  await client.query("DROP TABLE discovery_copied_fields");
  await initializePostgresRuntimeSchema(live.db);
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM pg_trigger
    WHERE tgrelid=to_regclass('people')
      AND tgname='clear_changed_discovery_copy_provenance' AND NOT tgisinternal`))
    .rows[0].count, 1, "upgrading to 061 restores the provenance invalidation trigger");
  await client.query(readFileSync(new URL("../../ops/postgres/061_discovery_copied_fields.sql", import.meta.url), "utf8"));
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM pg_policies
    WHERE schemaname=current_schema() AND tablename='discovery_copied_fields'`)).rows[0].count,
  1, "reapplying 061 keeps one archive-scoped RLS policy");
  const authorIndex = () => client.query(`SELECT indexdef FROM pg_indexes
    WHERE schemaname=current_schema() AND tablename='person_comments'
      AND indexname='person_comments_author'`);
  assert.match((await authorIndex()).rows[0]?.indexdef || "",
    /\(archive_id, author_id, id\)/,
    "account comment export has an author-ordered index");
  await client.query("DROP INDEX person_comments_author");
  await initializePostgresRuntimeSchema(live.db);
  assert.match((await authorIndex()).rows[0]?.indexdef || "",
    /\(archive_id, author_id, id\)/,
    "upgrading an older database installs the export index without a new import");
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
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES('union-upgrade-gate','Upgrade gate',now())");
    await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES('union-upgrade-session','union-upgrade-gate',$1)",
      [Date.now() + 60_000]);
    await assert.rejects(
      accountSelfDeletion(live.db, true).remove("union-upgrade-gate",
        { name: "Upgrade gate", leaveSharedArchives: true }, "union-upgrade-session"),
      /058/, "the old privileged function cannot delete an account with unredacted union authorship",
    );
    assert.equal((await client.query("SELECT count(*)::int AS n FROM deleted_account_tombstones WHERE id='union-upgrade-gate'")).rows[0].n,
      0, "the migration gate fails before creating a deletion tombstone");
    await client.query("DELETE FROM accounts WHERE id='union-upgrade-gate'");
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await client.query(`INSERT INTO people(archive_id,id,ordinal,data)
      SELECT 'runtime-test','old-union-peer',
        (SELECT COALESCE(max(ordinal),0)+1 FROM people WHERE archive_id='runtime-test'),
        jsonb_set(data,'{id}',to_jsonb('old-union-peer'::text))
      FROM people WHERE id='person-a'`);
    await client.query("INSERT INTO deleted_account_tombstones(id) VALUES('old-union-author'),('reused-union-author')");
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES('reused-union-author','Reused ID',now())");
    for (const [id, createdBy] of [
      ["old-union-backfill", "old-union-author"],
      ["reused-union-review", "reused-union-author"],
      ["unrelated-union-backfill", "owner"],
    ]) await client.query(`INSERT INTO family_unions(archive_id,id,participant_a,participant_b,data)
      VALUES('runtime-test',$1,'person-a','old-union-peer',$2::jsonb)`,
    [id, JSON.stringify({ id, participants: ["person-a", "old-union-peer"], type: "partnership", createdBy, note: "Keep" })]);
    const migration058 = readFileSync(new URL("../../ops/postgres/058_deleted_account_union_authors.sql", import.meta.url), "utf8");
    if (adminClient !== client) {
      await assert.rejects(client.query(migration058), /BYPASSRLS/,
        "the app role cannot run the privileged migration");
      await client.query("ROLLBACK");
    }
    await adminClient.query(migration058);
    await adminClient.query(migration058);
    if (adminClient !== client) {
      await client.query("INSERT INTO accounts(id,name,created_at) VALUES('first-union-author','First union',now())");
      await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
        VALUES('runtime-test','first-union-author','researcher',true,'all')`);
      await client.query("INSERT INTO deleted_account_tombstones(id) VALUES('first-union-author')");
      const writerPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const cleanupPid = (await adminClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await client.query("BEGIN");
      await client.query("SELECT set_config('drevo.archive_id','runtime-test',true)");
      await client.query("SELECT id FROM archives WHERE id='runtime-test' FOR UPDATE");
      await client.query(`INSERT INTO family_unions(archive_id,id,participant_a,participant_b,data)
        VALUES('runtime-test','first-union','person-a','old-union-peer',
          '{"id":"first-union","participants":["person-a","old-union-peer"],"type":"partnership","createdBy":"first-union-author"}'::jsonb)`);
      const cleanup = adminClient.query("SELECT public.runtime_anonymize_deleted_account_unions('first-union-author')");
      let writerCommitted = false;
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const blockers = (await client.query("SELECT pg_blocking_pids($1) AS pids", [cleanupPid])).rows[0].pids as number[];
          if (blockers.includes(writerPid)) { blocked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(blocked, true,
          "union cleanup waits for an in-flight first union from a current member, even though its row is not committed");
        await client.query("COMMIT");
        writerCommitted = true;
        await cleanup;
      } finally {
        if (!writerCommitted) await client.query("ROLLBACK");
        await cleanup.catch(() => undefined);
      }
      assert.equal((await client.query("SELECT data->>'createdBy' AS author FROM family_unions WHERE id='first-union'")).rows[0].author,
        "deleted-account", "the first in-flight union is redacted after its writer commits");
      await client.query("DELETE FROM family_unions WHERE id='first-union'");
      await client.query("DELETE FROM archive_memberships WHERE user_id='first-union-author'");
      await client.query("DELETE FROM accounts WHERE id='first-union-author'");
      await client.query("DELETE FROM deleted_account_tombstones WHERE id='first-union-author'");
    }
    assert.deepEqual((await client.query("SELECT id,data->>'createdBy' AS author FROM family_unions WHERE id LIKE '%union-%' ORDER BY id")).rows,
      [{ id: "old-union-backfill", author: "deleted-account" },
        { id: "reused-union-review", author: "reused-union-author" },
        { id: "unrelated-union-backfill", author: "owner" }],
    "migration 058 only backfills tombstoned IDs without an active account and leaves unrelated unions unchanged");
    await client.query("DELETE FROM family_unions WHERE id IN ('old-union-backfill','reused-union-review','unrelated-union-backfill')");
    await client.query("DELETE FROM people WHERE id='old-union-peer'");
    await client.query("DELETE FROM accounts WHERE id='reused-union-author'");
    await client.query("DELETE FROM deleted_account_tombstones WHERE id IN ('old-union-author','reused-union-author')");
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES('annotation-upgrade-gate','Upgrade gate',now())");
    await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES('annotation-upgrade-session','annotation-upgrade-gate',$1)",
      [Date.now() + 60_000]);
    await assert.rejects(
      accountSelfDeletion(live.db, true).remove("annotation-upgrade-gate",
        { name: "Upgrade gate", leaveSharedArchives: true }, "annotation-upgrade-session"),
      /059/, "deletion cannot leave document annotation author IDs behind before migration 059",
    );
    assert.equal((await client.query("SELECT count(*)::int AS n FROM deleted_account_tombstones WHERE id='annotation-upgrade-gate'")).rows[0].n,
      0, "the annotation migration gate fails before writing a deletion tombstone");
    await client.query("DELETE FROM accounts WHERE id='annotation-upgrade-gate'");
    const backfillDocumentId = "11111111-1111-4111-8111-111111111159";
    const annotation = (id: string, authorId: string, authorName: string) => ({
      id, page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.2,
      text: "Keep note", authorId, authorName, createdAt: "2026-01-01T00:00:00.000Z",
    });
    const backfillAnnotations = [
      annotation("old", "old-annotation-author", "Former name"),
      annotation("reused", "reused-annotation-author", "Active name"),
      annotation("other", "owner", "Owner"),
    ];
    await client.query("INSERT INTO deleted_account_tombstones(id) VALUES('old-annotation-author'),('reused-annotation-author')");
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES('reused-annotation-author','Active name',now())");
    await client.query(`INSERT INTO documents(archive_id,id,ordinal,title,title_search,file_name,file_size,uploaded_by,created_at,annotations)
      VALUES('runtime-test',$1,(SELECT COALESCE(max(ordinal),0)+1 FROM documents WHERE archive_id='runtime-test'),
        'Annotation backfill','annotation backfill','annotation-backfill.pdf',1,'owner',now(),$2)`,
    [backfillDocumentId, JSON.stringify(backfillAnnotations)]);
    const migration059 = readFileSync(new URL("../../ops/postgres/059_deleted_account_annotation_authors.sql", import.meta.url), "utf8");
    if (adminClient !== client) {
      await assert.rejects(client.query(migration059), /BYPASSRLS/,
        "the app role cannot replace the privileged annotation function");
      await client.query("ROLLBACK");
    }
    await adminClient.query(migration059);
    await adminClient.query(migration059);
    const alreadyBackfilled = JSON.parse((await client.query(
      "SELECT annotations FROM documents WHERE id=$1", [backfillDocumentId],
    )).rows[0].annotations);
    assert.deepEqual(alreadyBackfilled,
      [{ ...backfillAnnotations[0], authorId: "deleted-account", authorName: "Удалённый участник" },
        backfillAnnotations[1], backfillAnnotations[2]],
    "059 backfills only an unambiguously deleted author and preserves other annotations");
    if (adminClient !== client) {
      await client.query("INSERT INTO accounts(id,name,created_at) VALUES('first-annotation-author','First annotation',now())");
      await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
        VALUES('runtime-test','first-annotation-author','researcher',true,'all')`);
      await client.query("INSERT INTO deleted_account_tombstones(id) VALUES('first-annotation-author')");
      const writerPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const cleanupPid = (await adminClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await client.query("BEGIN");
      await client.query("SELECT set_config('drevo.archive_id','runtime-test',true)");
      await client.query("SELECT id FROM archives WHERE id='runtime-test' FOR UPDATE");
      await client.query("UPDATE documents SET annotations=$2 WHERE id=$1",
        [backfillDocumentId, JSON.stringify([...alreadyBackfilled,
          annotation("first", "first-annotation-author", "First annotation")])]);
      const cleanup = adminClient.query("SELECT public.runtime_anonymize_deleted_account_annotations('first-annotation-author')");
      let writerCommitted = false;
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const blockers = (await client.query("SELECT pg_blocking_pids($1) AS pids", [cleanupPid])).rows[0].pids as number[];
          if (blockers.includes(writerPid)) { blocked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(blocked, true, "annotation cleanup waits for an in-flight first annotation from a current member");
        await client.query("COMMIT");
        writerCommitted = true;
        await cleanup;
      } finally {
        if (!writerCommitted) await client.query("ROLLBACK");
        await cleanup.catch(() => undefined);
      }
      assert.deepEqual(JSON.parse((await client.query("SELECT annotations FROM documents WHERE id=$1", [backfillDocumentId])).rows[0].annotations)[3],
        { ...annotation("first", "first-annotation-author", "First annotation"),
          authorId: "deleted-account", authorName: "Удалённый участник" });
      await client.query("DELETE FROM archive_memberships WHERE user_id='first-annotation-author'");
      await client.query("DELETE FROM accounts WHERE id='first-annotation-author'");
      await client.query("DELETE FROM deleted_account_tombstones WHERE id='first-annotation-author'");
    }
    assert.deepEqual(JSON.parse((await client.query("SELECT annotations FROM documents WHERE id=$1", [backfillDocumentId])).rows[0].annotations),
      [...alreadyBackfilled,
        ...(adminClient !== client ? [{ ...annotation("first", "first-annotation-author", "First annotation"),
          authorId: "deleted-account", authorName: "Удалённый участник" }] : [])],
    "the concurrent first annotation is redacted without reverting the earlier backfill");
    await client.query("DELETE FROM documents WHERE id=$1", [backfillDocumentId]);
    await client.query("DELETE FROM accounts WHERE id='reused-annotation-author'");
    await client.query("DELETE FROM deleted_account_tombstones WHERE id IN ('old-annotation-author','reused-annotation-author')");
    await adminClient.query(`GRANT EXECUTE ON FUNCTION public.runtime_anonymize_deleted_account_history(text) TO ${runtimeRole}`);
    await adminClient.query(`GRANT EXECUTE ON FUNCTION public.runtime_redact_deleted_account_comments(text) TO ${runtimeRole}`);
  } finally {
    if (adminClient !== client) await adminClient.end();
  }
  const runtimePrivileges = (await client.query(`SELECT
    has_function_privilege(current_user,'public.runtime_anonymize_deleted_account_history(text)','EXECUTE') AS entrypoint,
    has_function_privilege(current_user,'public.runtime_redact_deleted_account_comments(text)','EXECUTE') AS comment_redaction,
    has_function_privilege(current_user,'public.runtime_anonymize_account_history_rows(text)','EXECUTE') AS internal,
    has_function_privilege(current_user,'public.runtime_anonymize_deleted_account_unions(text)','EXECUTE') AS unions_internal,
    has_function_privilege(current_user,'public.runtime_anonymize_deleted_account_annotations(text)','EXECUTE') AS annotations_internal,
    has_function_privilege(current_user,'public.runtime_redact_account_attribution(jsonb,text)','EXECUTE') AS helper,
    (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged`)).rows[0];
  if (!runtimePrivileges.privileged) {
    assert.equal(runtimePrivileges.entrypoint, true);
    assert.equal(runtimePrivileges.comment_redaction, true);
    assert.equal(runtimePrivileges.internal, false);
    assert.equal(runtimePrivileges.unions_internal, false);
    assert.equal(runtimePrivileges.annotations_internal, false);
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
  const backupCatalogCreated = await fetch(base + "/api/sources", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Источник из бэкапа", documentIds: [documents.items[0].id] }),
  });
  assert.equal(backupCatalogCreated.status, 201, await backupCatalogCreated.clone().text());
  const backupCatalog = (await backupCatalogCreated.json()).source;
  const backupClaimBefore = await app.archive.read();
  const backupClaimFamily = structuredClone(backupClaimBefore.family);
  backupClaimFamily.people.find((person) => person.id === "person-a")!.birthDateClaim = {
    value: "1990", sources: [{ catalogId: backupCatalog.id, title: backupCatalog.title,
      type: "", reference: "", documentId: documents.items[0].id }],
  };
  await app.archive.write(backupClaimFamily, backupClaimBefore.revision);
  const fullBackup = await fetch(base + "/api/backup/full");
  assert.equal(fullBackup.status, 200);
  const backupBytes = await fullBackup.arrayBuffer();
  const restoreBytes = Buffer.from(backupBytes);
  const stagingRoot = join(dirname(source), "staging");
  const diskFree = async () => {
    const disk = await statfs(stagingRoot);
    return disk.bavail * disk.bsize;
  };
  const platformPending = async () => Number((await app!.archive.db
    .prepare("", "SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM platform_upload_reservations")
    .get())?.bytes || 0);
  const reservationCount = async () => Number((await app!.archive.db
    .prepare("", "SELECT count(*) AS count FROM platform_upload_reservations")
    .get())?.count || 0);
  const blockRestoreSpace = async (id: string, headroom: number) => {
    const bytes = (await diskFree()) - (await platformPending()) -
      256 * 1024 ** 2 - headroom;
    assert.ok(Number.isSafeInteger(bytes) && bytes > 0);
    await app!.archive.db.prepare("", `INSERT INTO platform_upload_reservations
      (id,reserved_bytes,expires_ms) VALUES(?,?,?)`).run(id, bytes, Date.now() + 5 * 60_000);
  };
  const firstRestores = restoreStore(app.archive, source);
  const secondRestores = restoreStore(app.archive, source);
  let unblockFirst!: () => void;
  let firstChunkReady!: () => void;
  const firstChunk = new Promise<void>((resolve) => { firstChunkReady = resolve; });
  const firstGate = new Promise<void>((resolve) => { unblockFirst = resolve; });
  let heldPreview: Promise<Awaited<ReturnType<typeof firstRestores.previewStream>>> | undefined;
  const stageNamesBefore = readdirSync(stagingRoot).filter((name) => name.startsWith("restore-"));
  const reservationsBefore = await reservationCount();
  try {
    await blockRestoreSpace("restore-preview-blocker", 48 * 1024 ** 2);
    heldPreview = firstRestores.previewStream(Readable.from((async function* () {
      yield restoreBytes.subarray(0, 1024);
      firstChunkReady();
      await firstGate;
      yield restoreBytes.subarray(1024);
    })()), owner);
    await firstChunk;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await reservationCount() > reservationsBefore + 1) break;
      if (attempt === 99) throw new Error("First restore did not reserve disk space");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(
      secondRestores.previewStream(Readable.from([restoreBytes]), owner),
      (error: unknown) => error instanceof UploadQuotaError && error.status === 507,
      "a concurrent restore must respect another archive's disk reservation",
    );
    assert.equal(readdirSync(stagingRoot).filter((name) => name.startsWith("restore-")).length,
      stageNamesBefore.length + 1,
      "a rejected preview removes its partial staging directory");
  } finally {
    unblockFirst();
    try {
      const held = await heldPreview;
      if (held) await firstRestores.discard(held.token);
    } finally {
      await app.archive.db.prepare("", "DELETE FROM platform_upload_reservations WHERE id='restore-preview-blocker'").run();
      await firstRestores.close();
      await secondRestores.close();
    }
  }
  assert.deepEqual(readdirSync(stagingRoot).filter((name) => name.startsWith("restore-")), stageNamesBefore);
  assert.equal(await reservationCount(), reservationsBefore, "completed previews release disk reservations");
  const interruptedRestores = restoreStore(app.archive, source);
  try {
    let interruptUpload!: () => void;
    const interruptGate = new Promise<void>((resolve) => { interruptUpload = resolve; });
    const interrupted = interruptedRestores.previewStream(Readable.from((async function* () {
      yield restoreBytes.subarray(0, 1024);
      await interruptGate;
      throw new Error("Interrupted restore stream");
    })()), owner);
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await reservationCount() > reservationsBefore) break;
        if (attempt === 99) throw new Error("Interrupted restore did not reserve disk space");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      interruptUpload();
    }
    await assert.rejects(
      interrupted,
      /Interrupted restore stream/,
    );
    assert.deepEqual(readdirSync(stagingRoot).filter((name) => name.startsWith("restore-")), stageNamesBefore,
      "an interrupted upload removes its partial stage");
    assert.equal(await reservationCount(), reservationsBefore, "an interrupted upload releases its reservation");
    await assert.rejects(
      interruptedRestores.previewStream(Readable.from([restoreBytes.subarray(0, restoreBytes.length - 1)]), owner),
    );
    assert.deepEqual(readdirSync(stagingRoot).filter((name) => name.startsWith("restore-")), stageNamesBefore,
      "an unpack failure removes its partial stage");
    assert.equal(await reservationCount(), reservationsBefore, "an unpack failure releases its reservation");
  } finally {
    await interruptedRestores.close();
  }
  const preview = await fetch(base + "/api/restore/preview", {
    method: "POST",
    headers: { "X-Drevo-Restore": "1" },
    body: backupBytes,
  });
  assert.equal(preview.status, 200);
  const previewData = await preview.json();
  assert.equal(previewData.documents, 1);
  const uploadsBefore = readdirSync(uploads).sort();
  await blockRestoreSpace("restore-apply-blocker", 0);
  try {
    const blockedApply = await fetch(base + "/api/restore/apply", {
      method: "POST",
      headers: { "X-Drevo-Restore": "1" },
      body: JSON.stringify({ token: previewData.token, confirm: true }),
    });
    assert.equal(blockedApply.status, 507, await blockedApply.text());
  } finally {
    await app.archive.db.prepare("", "DELETE FROM platform_upload_reservations WHERE id='restore-apply-blocker'").run();
  }
  assert.equal((await app.archive.db.prepare("", "SELECT count(*) AS count FROM workflow_stages WHERE kind='restore' AND token=?").get(previewData.token))?.count, 1,
    "a rejected apply keeps the validated stage available for retry");
  assert.deepEqual(readdirSync(uploads).sort(), uploadsBefore,
    "a rejected apply does not leave partial media copies");
  assert.equal(await reservationCount(), reservationsBefore, "a rejected apply releases its reservation");
  assert.equal(await app.archive.db.prepare("", "SELECT 1 FROM platform_admins WHERE account_id=?").get("local"),
    undefined, "single-user PostgreSQL mode restores without a platform grant row");
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
  assert.notEqual(afterDocuments.items[0].id, documents.items[0].id);
  const restoredClaim = (await app.archive.read()).family.people.find((person) => person.id === "person-a")!
    .birthDateClaim?.sources[0];
  assert.equal(restoredClaim?.catalogId, backupCatalog.id);
  assert.equal(restoredClaim?.documentId, afterDocuments.items[0].id);
  const restoredSource = await fetch(base + "/api/sources/" + backupCatalog.id);
  assert.equal(restoredSource.status, 200);
  const restoredCatalog = (await restoredSource.json()).source;
  assert.deepEqual(restoredCatalog.documentIds, [afterDocuments.items[0].id]);
  assert.ok(restoredCatalog.version > backupCatalog.version);
  const staleCatalogEdit = await fetch(base + "/api/sources/" + backupCatalog.id, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: backupCatalog.version, title: "Устаревшая правка" }),
  });
  assert.equal(staleCatalogEdit.status, 409);
  const removeBackupClaim = await app.archive.read();
  const withoutBackupClaim = structuredClone(removeBackupClaim.family);
  delete withoutBackupClaim.people.find((person) => person.id === "person-a")!.birthDateClaim;
  await app.archive.write(withoutBackupClaim, removeBackupClaim.revision);
  const removeBackupSource = await fetch(base + "/api/sources/" + backupCatalog.id, {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: restoredCatalog.version }),
  });
  assert.equal(removeBackupSource.status, 200, await removeBackupSource.clone().text());
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
  const failedRestores = restoreStore(app.archive, source);
  try {
    const failedStage = await failedRestores.preview(restoreBytes, owner);
    const beforeFailedApply = readdirSync(uploads).sort();
    const originalWrite = app.archive.write;
    app.archive.write = async () => { throw new Error("Simulated restore apply failure"); };
    try {
      await assert.rejects(failedRestores.apply(failedStage.token, owner, async () => {}), /Simulated restore apply failure/);
    } finally {
      app.archive.write = originalWrite;
    }
    assert.deepEqual(readdirSync(uploads).sort(), beforeFailedApply,
      "failed apply rolls back already copied originals");
    assert.equal(await reservationCount(), reservationsBefore,
      "failed apply releases its copy reservation");
    assert.equal((await app.archive.db.prepare("", "SELECT count(*) AS count FROM workflow_stages WHERE token=?")
      .get(failedStage.token))?.count, 1, "failed apply leaves its stage available for retry");
    await failedRestores.discard(failedStage.token);
  } finally {
    await failedRestores.close();
  }
  const documentId = afterDocuments.items[0].id;
  const claimedBefore = await app.archive.read();
  const claimedFamily = structuredClone(claimedBefore.family);
  claimedFamily.people.find((person) => person.id === "person-a")!.birthDateClaim = {
    value: "1990", sources: [{ title: "Метрическая книга", type: "archive",
      reference: "л. 12", documentId, documentPage: 2 }],
  };
  await app.archive.write(claimedFamily, claimedBefore.revision);
  assert.equal((await fetch(base + "/api/documents/" + documentId, { method: "DELETE" })).status,
    409, "a PostgreSQL document cannot be deleted while an exact date cites it");
  const claimUnlink = await fetch(base + "/api/documents/" + documentId, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ people: { expected: ["person-a"], next: [] } }),
  });
  assert.equal(claimUnlink.status, 409, "a PostgreSQL citation keeps its person association");
  const clearedClaim = await app.archive.read();
  const clearedFamily = structuredClone(clearedClaim.family);
  delete clearedFamily.people.find((person) => person.id === "person-a")!.birthDateClaim;
  await app.archive.write(clearedFamily, clearedClaim.revision);
  const catalogCreated = await fetch(base + "/api/sources", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Метрическая книга", documentIds: [documentId] }),
  });
  assert.equal(catalogCreated.status, 201, await catalogCreated.clone().text());
  const catalogSource = (await catalogCreated.json()).source;
  assert.equal((await fetch(base + "/api/documents/" + documentId, { method: "DELETE" })).status,
    409, "a PostgreSQL catalog attachment keeps the document");
  const catalogDetached = await fetch(base + "/api/sources/" + catalogSource.id, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: catalogSource.version, documentIds: [] }),
  });
  assert.equal(catalogDetached.status, 200, await catalogDetached.clone().text());
  const catalogRemoved = await fetch(base + "/api/sources/" + catalogSource.id, {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: catalogSource.version + 1 }),
  });
  assert.equal(catalogRemoved.status, 200, await catalogRemoved.clone().text());
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
  // Local PostgreSQL mode uses the trusted "local" identity without an archive
  // membership row. A completed model answer must still pass the commit guard.
  const localAiKeys = ["YANDEX_AI_API_KEY", "YANDEX_AI_FOLDER_ID",
    "YANDEX_AI_MODEL", "YANDEX_AI_BASE_URL"] as const;
  const savedLocalAiEnvironment = localAiKeys.map((key) => process.env[key]);
  process.env.YANDEX_AI_API_KEY = "local-test-key";
  process.env.YANDEX_AI_FOLDER_ID = "local-test-folder";
  process.env.YANDEX_AI_MODEL = "local-test-model";
  process.env.YANDEX_AI_BASE_URL = "https://local-ai.invalid/v1";
  const localAnswer = "Ответ локального PostgreSQL архива";
  let localModelCalls = 0;
  const localAiFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://local-ai.invalid");
    assert.equal(init?.method, "POST");
    if (url.pathname === "/v1/conversations")
      return Response.json({ id: "local-test-conversation" });
    assert.equal(url.pathname, "/v1/responses");
    localModelCalls++;
    return Response.json({ id: "local-test-response", status: "completed",
      output_text: localAnswer, output: [],
      usage: { input_tokens: 1, output_tokens: 1 } });
  };
  try {
    app = await startServer(0, source, true, undefined, localAiFetch);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM archive_memberships
      WHERE archive_id='runtime-test' AND user_id='local'`)).rows[0].n, 0);
    const localBase = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const response = await fetch(localBase + "/api/ai/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Проверь локальный архив" }),
    });
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const { chatId, answer } = JSON.parse(raw) as { chatId: string; answer: string };
    assert.equal(answer, localAnswer);
    assert.ok(localModelCalls >= 1, "the answer must pass through the fake provider");
    const history = await fetch(localBase + `/api/ai/chats/${chatId}`);
    assert.equal(history.status, 200, await history.clone().text());
    assert.match(await history.text(), /Ответ локального PostgreSQL архива/);
    await aiChatStore(app.archive.db).delete(chatId, "local");
    await app.archive.db.prepare("", "DELETE FROM ai_usage WHERE user_id='local'").run();
  } finally {
    await app?.close();
    app = undefined;
    for (const [index, key] of localAiKeys.entries()) {
      const oldValue = savedLocalAiEnvironment[index];
      if (oldValue === undefined) delete process.env[key];
      else process.env[key] = oldValue;
    }
  }
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
    assert.equal(exported.version, 2);
    assert.equal(exported.account.id, index % 2 ? "reader" : "owner");
    assert.equal(exported.account.verifiedEmail, index % 2 ? "reader-export@example.invalid" : null);
    assert.deepEqual(exported.archives.map((item: { id: string }) => item.id), ["runtime-test"]);
    assert.equal(exported.archives[0].role, index % 2 ? "reader" : "admin");
    assert.equal(exported.archives[0].owned, index % 2 === 0);
    assert.equal(exported.archives[0].preferences?.colorScheme, index % 2 ? undefined : "white");
    assert.deepEqual(exported.archives[0].ownComments, []);
  }
  const chatToDeleteAfterDowngrade = await aiChatStore(app.archive.db).create("owner", "[]");
  const aiOwner = await (await userStore(app.archive.db)).get("owner");
  assert.ok(aiOwner);
  const delayedChat = await aiChatStore(app.archive.db).create("owner", JSON.stringify([
    aiOwner.role, aiOwner.treeAccess || "all", aiOwner.personId || "",
  ]));
  await aiChatStore(app.archive.db).append(delayedChat.id, "assistant", "downgrade-private-answer");
  const visibleBeforeDowngrade = await fetch(
    securedBase + `/api/ai/chats/${delayedChat.id}`, { headers: ownerHeaders },
  );
  assert.equal(visibleBeforeDowngrade.status, 200);
  assert.match(await visibleBeforeDowngrade.text(), /downgrade-private-answer/);
  const delayedAuth = await createAuth(await userStore(app.archive.db), app.archive.db,
    process.env.PUBLIC_ORIGIN);
  let downgradedBeforeDelivery = false;
  const delayedAi = aiResearchHttp({
    archive: app.archive,
    auth: delayedAuth,
    suggestions: researchSuggestionStore(app.archive.db),
    aiSettings: await aiSettingsStore(app.archive.db),
    usage: aiUsageStore(app.archive.db),
    media: mediaStore(join(dirname(source), "uploads")),
    previewImage: imagePreviews(join(dirname(source), "previews")),
    researchCatalog: researchCatalogStore(app.archive.db),
    publicOrigin: process.env.PUBLIC_ORIGIN,
    beforeChatDelivery: async () => {
      await client.query("UPDATE account_tiers SET full_access=false WHERE account_id='owner'");
      downgradedBeforeDelivery = true;
    },
  });
  const delayedServer = createServer((req, res) => {
    void delayedAi(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => { res.destroy(error); });
  });
  await new Promise<void>((resolve) => delayedServer.listen(0, "127.0.0.1", resolve));
  try {
    const delayedPort = (delayedServer.address() as { port: number }).port;
    const response = await fetch(
      `http://127.0.0.1:${delayedPort}/api/ai/chats/${delayedChat.id}`,
      { headers: ownerHeaders },
    );
    assert.equal(downgradedBeforeDelivery, true);
    assert.equal(response.status, 403,
      "a tier downgrade after loading messages blocks the old answer");
    assert.doesNotMatch(await response.text(), /downgrade-private-answer/);
  } finally {
    await client.query("UPDATE account_tiers SET full_access=true WHERE account_id='owner'");
    await aiChatStore(app.archive.db).delete(delayedChat.id, "owner");
    await new Promise<void>((resolve) => delayedServer.close(() => resolve()));
    await delayedAi.close();
  }
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
    const proposalMember = "ai-proposal-member";
    const proposalToken = newSessionToken();
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'AI proposal member',now())", [proposalMember]);
    await client.query("INSERT INTO account_tiers(account_id,full_access) VALUES($1,true)", [proposalMember]);
    await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
      VALUES('runtime-test',$1,'researcher',true,'all')`, [proposalMember]);
    await app.archive.db.prepare("", "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
      .run(sessionTokenHash(proposalToken), proposalMember, Date.now() + 60000);
    const proposalHeaders = { ...ownerHeaders, Cookie: `drevo_session=${proposalToken}` };
    const runDeferredAnswer = async (
      label: string,
      changeAccess: () => Promise<void>,
      restoreAccess: () => Promise<void>,
      allowed: boolean,
      revokeAfterWrite = false,
    ) => {
      let notify!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { notify = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const answer = `Deferred AI answer ${label}`;
      const fake = adaptLegacyAiFake(async (url) => {
        if (String(url).endsWith("/models"))
          return Response.json({ data: [{ id: "gpt://folder-1/yandexgpt/rc", owned_by: "Yandex" }] });
        notify();
        await gate;
        return Response.json({ choices: [{ message: { role: "assistant", content: answer } }] });
      });
      const handler = aiResearchHttp({
        archive: app!.archive,
        auth: await createAuth(await userStore(app!.archive.db), app!.archive.db,
          process.env.PUBLIC_ORIGIN),
        suggestions: researchSuggestionStore(app!.archive.db),
        aiSettings: await aiSettingsStore(app!.archive.db),
        usage: aiUsageStore(app!.archive.db),
        media: mediaStore(join(dirname(source), "uploads")),
        previewImage: imagePreviews(join(dirname(source), "previews")),
        researchCatalog: researchCatalogStore(app!.archive.db),
        publicOrigin: process.env.PUBLIC_ORIGIN,
        fetcher: fake,
        beforeAnswerDelivery: revokeAfterWrite ? changeAccess : undefined,
      });
      const server = createServer((req, res) => {
        void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
          .catch((error) => { res.destroy(error); });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const oldChats = new Set((await client.query("SELECT id FROM ai_chats WHERE user_id=$1", [proposalMember]))
        .rows.map((row) => row.id as string));
      const usageBefore = Number((await client.query(
        "SELECT coalesce(max(id),0) AS id FROM ai_usage WHERE archive_id='runtime-test' AND user_id=$1",
        [proposalMember],
      )).rows[0].id);
      try {
        const port = (server.address() as { port: number }).port;
        const request = fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
          method: "POST", headers: proposalHeaders,
          body: JSON.stringify({ message: `Проверь отложенный ответ ${label}` }),
        });
        await Promise.race([entered, request.then(async (response) => {
          throw new Error(`Deferred AI stopped before provider: ${response.status} ${await response.clone().text()}`);
        }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI provider did not start")), 15000))]);
        if (!revokeAfterWrite) await changeAccess();
        release();
        const response = await request;
        const body = await response.text();
        assert.equal(response.status, allowed ? 200 : 403, body);
        assert.equal(body.includes(answer), allowed, "revoked access cannot receive the model answer");
        assert.equal((await client.query("SELECT count(*)::int AS n FROM ai_chat_messages WHERE content=$1", [answer])).rows[0].n,
          allowed || revokeAfterWrite ? 1 : 0,
          "the durable answer follows the membership and tier lock order");
      } finally {
        release();
        await restoreAccess();
        const newChats = (await client.query("SELECT id FROM ai_chats WHERE user_id=$1", [proposalMember]))
          .rows.map((row) => row.id as string).filter((id) => !oldChats.has(id));
        for (const chatId of newChats) await aiChatStore(app!.archive.db).delete(chatId, proposalMember);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await handler.close();
        await client.query("DELETE FROM ai_usage WHERE archive_id='runtime-test' AND user_id=$1 AND id>$2",
          [proposalMember, usageBefore]);
      }
    };
    const proposalReason = (label: string) => `AI proposal guard ${label}`;
    const runProposal = async (
      actorHeaders: typeof ownerHeaders,
      actorId: string,
      label: string,
      duringProvider: (release: () => void) => Promise<void>,
      allowed: boolean,
    ) => {
      let notify!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { notify = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reason = proposalReason(label);
      const fake = adaptLegacyAiFake(async (url, init) => {
        if (String(url).endsWith("/models"))
          return Response.json({ data: [{ id: "gpt://folder-1/yandexgpt/rc", owned_by: "Yandex" }] });
        const request = JSON.parse(String(init?.body));
        if (request.messages.some((item: { role: string }) => item.role === "tool"))
          return Response.json({ choices: [{ message: { role: "assistant", content: "Предложение обработано." } }] });
        assert.ok(request.tools.some((item: { function: { name: string } }) =>
          item.function.name === "propose_person_create"));
        notify();
        await gate;
        return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{
          id: `proposal-${label}`, type: "function", function: {
            name: "propose_person_create", arguments: JSON.stringify({
              person: { surname: "Проверка", name: label, sex: "m", birth: "1991" },
              reason, evidence: ["Данные участника"],
            }),
          },
        }] } }] });
      });
      const handler = aiResearchHttp({
        archive: app!.archive, auth: await createAuth(await userStore(app!.archive.db), app!.archive.db,
          process.env.PUBLIC_ORIGIN), suggestions: researchSuggestionStore(app!.archive.db),
        aiSettings: await aiSettingsStore(app!.archive.db), usage: aiUsageStore(app!.archive.db),
        media: mediaStore(join(dirname(source), "uploads")),
        previewImage: imagePreviews(join(dirname(source), "previews")),
        researchCatalog: researchCatalogStore(app!.archive.db),
        publicOrigin: process.env.PUBLIC_ORIGIN, fetcher: fake,
      });
      const server = createServer((req, res) => {
        void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
          .catch((error) => { res.destroy(error); });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const port = (server.address() as { port: number }).port;
        const oldChats = new Set((await client.query("SELECT id FROM ai_chats WHERE user_id=$1", [actorId]))
          .rows.map((row) => row.id as string));
        const request = fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
          method: "POST", headers: actorHeaders,
          body: JSON.stringify({ message: "Добавь новую карточку человека" }),
        });
        await Promise.race([entered, request.then(async (response) => {
          throw new Error(`Proposal stopped before provider: ${response.status} ${await response.clone().text()}`);
        }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Proposal provider did not start")), 15000))]);
        await duringProvider(release);
        release();
        const response = await request;
        const body = await response.text();
        assert.equal(response.status, allowed ? 200 : 403, body);
        if (!allowed) assert.doesNotMatch(body, /Предложение обработано/);
        assert.equal((await client.query("SELECT count(*)::int AS n FROM research_suggestions WHERE reason=$1", [reason])).rows[0].n,
          allowed ? 1 : 0, "the proposal write obeys the current account tier and archive role");
        const chatId = (await client.query("SELECT id FROM ai_chats WHERE user_id=$1", [actorId]))
          .rows.map((row) => row.id as string).find((id) => !oldChats.has(id));
        assert.ok(chatId);
        await aiChatStore(app!.archive.db).delete(chatId, actorId);
      } finally {
        release();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await handler.close();
      }
    };
    try {
      await runDeferredAnswer("allowed", async () => {}, async () => {}, true);
      await runDeferredAnswer("membership-revoked", async () => {
        await client.query("UPDATE archive_memberships SET approved=false WHERE archive_id='runtime-test' AND user_id=$1",
          [proposalMember]);
      }, async () => {
        await client.query("UPDATE archive_memberships SET approved=true WHERE archive_id='runtime-test' AND user_id=$1",
          [proposalMember]);
      }, false);
      await runDeferredAnswer("tier-downgraded", async () => {
        await client.query("UPDATE account_tiers SET full_access=false WHERE account_id=$1", [proposalMember]);
      }, async () => {
        await client.query("UPDATE account_tiers SET full_access=true WHERE account_id=$1", [proposalMember]);
      }, false);
      await runDeferredAnswer("session-revoked", async () => {
        await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [sessionTokenHash(proposalToken)]);
      }, async () => {
        await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
          [sessionTokenHash(proposalToken), proposalMember, Date.now() + 60000]);
      }, false);
      await runDeferredAnswer("delivery-revoked", async () => {
        await client.query("UPDATE archive_memberships SET approved=false WHERE archive_id='runtime-test' AND user_id=$1",
          [proposalMember]);
      }, async () => {
        await client.query("UPDATE archive_memberships SET approved=true WHERE archive_id='runtime-test' AND user_id=$1",
          [proposalMember]);
      }, false, true);
      const rollbackReason = proposalReason("rollback");
      const rollbackActor = await (await userStore(app.archive.db)).get("owner");
      const rollbackFamily = await app.archive.read();
      assert.ok(rollbackActor);
      await assert.rejects(app.archive.db.transaction(async () => {
        await researchSuggestionStore(app!.archive.db).createFromTool(
          "propose_person_create", rollbackActor, rollbackFamily.family, rollbackFamily.revision,
          { person: { surname: "Проверка", name: "Rollback", sex: "m", birth: "1991" },
            reason: rollbackReason, evidence: ["Данные участника"] },
        );
        throw new Error("rollback proposal transaction");
      }), /rollback proposal transaction/);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM research_suggestions WHERE reason=$1", [rollbackReason])).rows[0].n,
        0, "suggestion insert uses the archive transaction and rolls back with it");
      await runProposal(ownerHeaders, "owner", "allowed", async (release) => { release(); }, true);
      await runProposal(ownerHeaders, "owner", "downgraded", async (release) => {
        const downgrade = client.query("UPDATE account_tiers SET full_access=false WHERE account_id='owner'");
        const completed = await Promise.race([downgrade.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))]);
        release();
        await downgrade;
        assert.equal(completed, true, "waiting for the external model must not hold the tier lock");
      }, false);
      await client.query("UPDATE account_tiers SET full_access=true WHERE account_id='owner'");
      await runProposal(proposalHeaders, proposalMember, "role-revoked", async (release) => {
        await client.query("UPDATE archive_memberships SET role='reader' WHERE archive_id='runtime-test' AND user_id=$1",
          [proposalMember]);
        release();
      }, false);
      await client.query("UPDATE archive_memberships SET role='researcher' WHERE archive_id='runtime-test' AND user_id=$1",
        [proposalMember]);
      await runProposal(proposalHeaders, proposalMember, "membership-revoked", async (release) => {
        await client.query("UPDATE archive_memberships SET approved=false WHERE archive_id='runtime-test' AND user_id=$1",
          [proposalMember]);
        release();
      }, false);
    } finally {
      await client.query("UPDATE account_tiers SET full_access=true WHERE account_id='owner'");
      await client.query("DELETE FROM research_suggestions WHERE reason=$1", [proposalReason("allowed")]);
      await client.query("DELETE FROM archive_memberships WHERE archive_id='runtime-test' AND user_id=$1", [proposalMember]);
      await client.query("DELETE FROM account_sessions WHERE user_id=$1", [proposalMember]);
      await client.query("DELETE FROM account_tiers WHERE account_id=$1", [proposalMember]);
      await client.query("DELETE FROM accounts WHERE id=$1", [proposalMember]);
    }
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
  const exportAuth = await createAuth(await userStore(app.archive.db), app.archive.db,
    process.env.PUBLIC_ORIGIN);
  for (const [path, options, revoke] of [
    ["/api/gedcom/export?format=gedcom7", { headers: archiveAdminHeaders },
      "UPDATE archive_memberships SET role='reader' WHERE archive_id='runtime-test' AND user_id='vk:42'"],
    ["/api/gedcom/export-visible?format=gedcom551", {
      method: "POST",
      headers: { ...archiveAdminHeaders, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ids: JSON.stringify(["person-a"]) }),
    }, "UPDATE archive_memberships SET approved=false WHERE archive_id='runtime-test' AND user_id='vk:42'"],
  ] as const) {
    let reachedRead!: () => void;
    let resumeRead!: () => void;
    const readReached = new Promise<void>((resolve) => { reachedRead = resolve; });
    const readGate = new Promise<void>((resolve) => { resumeRead = resolve; });
    const delayedArchive = {
      ...app.archive,
      read: async () => {
        const snapshot = await app!.archive.read();
        reachedRead();
        await readGate;
        return snapshot;
      },
    };
    const delayedExport = gedcomHttp(delayedArchive, exportAuth, source, process.env.PUBLIC_ORIGIN);
    const exportServer = createServer((req, res) => {
      void delayedExport.handle(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .catch((error) => { res.destroy(error); });
    });
    await new Promise<void>((resolve) => exportServer.listen(0, "127.0.0.1", resolve));
    try {
      const port = (exportServer.address() as { port: number }).port;
      const pending = fetch(`http://127.0.0.1:${port}${path}`, options);
      let timer!: ReturnType<typeof setTimeout>;
      const progress = await Promise.race([
        readReached.then(() => "read"),
        pending.then(() => "responded"),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timed out"), 10_000); }),
      ]);
      clearTimeout(timer);
      assert.equal(progress, "read", "the export must reach the gated archive snapshot");
      await client.query(revoke);
      resumeRead();
      const response = await pending;
      assert.equal(response.status, 403,
        "a revoked archive admin cannot receive a prepared plain GEDCOM export");
      assert.doesNotMatch(await response.text(), /0 HEAD|1 NAME/);
    } finally {
      resumeRead();
      await client.query("UPDATE archive_memberships SET role='admin',approved=true WHERE archive_id='runtime-test' AND user_id='vk:42'");
      await delayedExport.close();
      await new Promise<void>((resolve) => exportServer.close(() => resolve()));
    }
  }
  await client.query("UPDATE archive_memberships SET approved=false WHERE archive_id='runtime-test' AND user_id='vk:42'");
  try {
    for (const format of ["gedcom7", "gedzip7"])
      assert.equal((await fetch(securedBase + `/api/gedcom/export?format=${format}`, {
        headers: archiveAdminHeaders,
      })).status, 403, "an unapproved archive admin cannot start a GEDCOM export");
  } finally {
    await client.query("UPDATE archive_memberships SET approved=true WHERE archive_id='runtime-test' AND user_id='vk:42'");
  }
  const commentAuthorLink = await app.archive.db.prepare("", "SELECT person_id FROM archive_memberships WHERE user_id='owner'").get();
  await app.archive.db.prepare("", "UPDATE archive_memberships SET person_id='person-a' WHERE user_id='owner'").run();
  try {
    await verifyPostgresCommentEdits(securedBase, ownerHeaders, archiveAdminHeaders, app.archive.db);
  } finally {
    await app.archive.db.prepare("", "UPDATE archive_memberships SET person_id=? WHERE user_id='owner'").run(commentAuthorLink?.person_id == null ? null : String(commentAuthorLink.person_id));
  }
  assert.equal(
    (await fetch(securedBase + "/api/family?projection=overview", {
      headers: archiveAdminHeaders,
    }).then((response) => response.json())).user.platformAdmin,
    false,
  );
  for (const path of ["/api/backups", "/api/backup", "/api/backup/full",
    "/api/backups/settings"]) {
    assert.equal(
      (await fetch(securedBase + path, { headers: archiveAdminHeaders })).status,
      403,
    );
  }
  for (const [path, method, body] of [
    ["/api/backups/settings", "PUT", "{}"],
    ["/api/backups/create", "POST", "{}"],
    ["/api/backups/check", "POST", "{}"],
    ["/api/restore/preview", "POST", "invalid backup"],
    ["/api/restore/apply", "POST", JSON.stringify({ token: "invalid", confirm: true })],
  ] as const)
    assert.equal((await fetch(securedBase + path, {
      method,
      headers: { ...archiveAdminHeaders, "x-drevo-restore": "1", "x-drevo-backup": "1" },
      body,
    })).status, 403, `a tree admin cannot operate the system endpoint ${path}`);
  await app.archive.db.prepare("", "UPDATE account_sessions SET expires_at=? WHERE token_hash=?")
    .run(Date.now() + 5 * 60_000, sessionTokenHash(aiOwnerToken));
  let reachedSend!: () => void;
  let resumeSend!: () => void;
  const sendReady = new Promise<void>((resolve) => { reachedSend = resolve; });
  const sendGate = new Promise<void>((resolve) => { resumeSend = resolve; });
  const backupAuth = await createAuth(await userStore(app.archive.db), app.archive.db,
    process.env.PUBLIC_ORIGIN);
  const backupEndpoint = databaseBackupHttp({
    archive: app.archive,
    auth: backupAuth,
    beforeSend: async () => { reachedSend(); await sendGate; },
  });
  const backupServer = createServer((req, res) => {
    void backupEndpoint(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => { res.destroy(error); });
  });
  await new Promise<void>((resolve) => backupServer.listen(0, "127.0.0.1", resolve));
  try {
    const backupPort = (backupServer.address() as { port: number }).port;
    const download = fetch(`http://127.0.0.1:${backupPort}/api/backup/full`, {
      headers: ownerHeaders,
    });
    await Promise.race([
      sendReady,
      download.then(() => { throw new Error("Backup sent before the access recheck"); }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Backup preparation did not reach the send barrier")), 30_000);
        timer.unref();
      }),
    ]);
    await client.query("DELETE FROM platform_admins WHERE account_id='owner'");
    resumeSend();
    const revoked = await download;
    assert.equal(revoked.status, 403, "revocation after assembly stops full backup delivery");
    assert.match(revoked.headers.get("content-type") || "", /application\/json/);
    assert.match(await revoked.text(), /отозван/);
  } finally {
    resumeSend();
    await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
    await new Promise<void>((resolve) => backupServer.close(() => resolve()));
  }
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
  await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
  await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
    VALUES('other-archive','vk:42','admin',true,'all')`);
  const priorSelectedOwner = (await client.query(
    "SELECT user_id FROM archive_owners WHERE archive_id='other-archive'",
  )).rows[0]?.user_id as string | undefined;
  await client.query(`INSERT INTO archive_owners(archive_id,user_id)
    VALUES('other-archive','vk:42') ON CONFLICT (archive_id) DO UPDATE SET user_id='vk:42'`);
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  try {
    const selectedAdmin = await fetch(securedBase + "/a/other-archive/api/session", {
      headers: archiveAdminHeaders,
    }).then((response) => response.json());
    assert.equal(selectedAdmin.user.role, "admin");
    assert.equal(selectedAdmin.user.platformAdmin, false);
    for (const path of ["/api/backups", "/api/backup", "/api/backup/full",
      "/api/backups/settings"])
      assert.equal((await fetch(securedBase + "/a/other-archive" + path, {
        headers: archiveAdminHeaders,
      })).status, 403, `tree admin must not download ${path} from a second archive`);
    for (const [path, method, body] of [
      ["/api/backups/settings", "PUT", "{}"],
      ["/api/backups/create", "POST", "{}"],
      ["/api/backups/check", "POST", "{}"],
      ["/api/restore/preview", "POST", "invalid backup"],
      ["/api/restore/apply", "POST", JSON.stringify({ token: "invalid", confirm: true })],
    ] as const)
      assert.equal((await fetch(securedBase + "/a/other-archive" + path, {
        method,
        headers: { ...archiveAdminHeaders, "x-drevo-restore": "1", "x-drevo-backup": "1" },
        body,
      })).status, 403, `tree admin must not mutate ${path} in a second archive`);
  } finally {
    await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
    if (priorSelectedOwner)
      await client.query("UPDATE archive_owners SET user_id=$1 WHERE archive_id='other-archive'", [priorSelectedOwner]);
    else await client.query("DELETE FROM archive_owners WHERE archive_id='other-archive'");
    await client.query("DELETE FROM archive_memberships WHERE archive_id='other-archive' AND user_id='vk:42'");
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  }
  const selectedBackup = await fetch(securedBase + "/a/other-archive/api/backup", {
    headers: ownerHeaders,
  });
  assert.equal(selectedBackup.status, 200);
  const selectedBackupFile = join(directory, "selected-archive-backup.sqlite");
  writeFileSync(selectedBackupFile, Buffer.from(await selectedBackup.arrayBuffer()));
  const selectedBackupDb = new DatabaseSync(selectedBackupFile, { readOnly: true });
  try {
    const selectedPerson = selectedBackupDb.prepare("SELECT data FROM people WHERE id='person-a'").get();
    assert.equal(JSON.parse(String(selectedPerson?.data)).name,
      (await otherApp.archive.read()).family.people.find((person) => person.id === "person-a")?.name,
      "platform admin backup contains only the selected archive's people");
    assert.notEqual(JSON.parse(String(selectedPerson?.data)).name,
      (await app.archive.read()).family.people.find((person) => person.id === "person-a")?.name);
  } finally {
    selectedBackupDb.close();
    rmSync(selectedBackupFile, { force: true });
  }
  const selectedFullBackup = await fetch(securedBase + "/a/other-archive/api/backup/full", {
    headers: ownerHeaders,
  });
  assert.equal(selectedFullBackup.status, 200);
  assert.match(selectedFullBackup.headers.get("content-type") || "", /application\/gzip/);
  await selectedFullBackup.arrayBuffer();
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
  // The account download includes only the caller's current comments in trees
  // they can still read. A restricted reader must not recover a hidden branch.
  const hiddenForExport = {
    ...family.people[0], id: "account-export-hidden", name: "Скрытый",
    parents: [], spouses: [],
  };
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  await client.query(
    `INSERT INTO people(id,ordinal,data)
     VALUES('account-export-hidden',(SELECT max(ordinal)+1 FROM people),$1)`,
    [JSON.stringify(hiddenForExport)],
  );
  await client.query(
    `INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text)
     VALUES('person-a','owner','Owner',$1,'account-export-probe:root-owner'),
           ('person-a','reader','Reader',$1,'account-export-probe:visible'),
           ('account-export-hidden','reader','Reader',$1,'account-export-probe:hidden')`,
    [Date.now()],
  );
  await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
  await client.query(
    `INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text)
     VALUES('person-a','owner','Owner',$1,'account-export-probe:other-owner')`,
    [Date.now()],
  );
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  await client.query(
    "UPDATE archive_memberships SET tree_access='common_ancestors',person_id='person-a' WHERE user_id='reader'",
  );
  // A parent edge exposes the reader's old comment through common ancestors.
  // Removing that edge while export.read() is preparing the response must
  // invalidate the snapshot even though the membership itself has not changed.
  await client.query(
    `INSERT INTO relations(id,ordinal,source,target,type)
     VALUES('account-export-parent',(SELECT COALESCE(max(ordinal),0)+1 FROM relations),
       'account-export-hidden','person-a','parent')`,
  );
  await client.query("UPDATE archives SET revision=revision+1 WHERE id='runtime-test'");
  const graphSnapshot = await accountDataExport(app.archive.db).read("reader");
  assert.ok(graphSnapshot);
  assert.ok(graphSnapshot.download.archives[0].ownComments?.some(
    (comment) => comment.text === "account-export-probe:hidden",
  ), "a recorded parent relation exposes the comment before the graph change");
  const graphAuth = await createAuth(await userStore(app.archive.db), app.archive.db,
    process.env.PUBLIC_ORIGIN);
  let graphChanged = false;
  const graphExportEndpoint = accountDataExportHttp(app.archive.db, graphAuth, async () => {
    await client.query("DELETE FROM relations WHERE id='account-export-parent'");
    await client.query("UPDATE archives SET revision=revision+1 WHERE id='runtime-test'");
    graphChanged = true;
  });
  const graphExportServer = createServer((req, res) => {
    void graphExportEndpoint(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => { res.destroy(error); });
  });
  await new Promise<void>((resolve) => graphExportServer.listen(0, "127.0.0.1", resolve));
  try {
    const graphPort = (graphExportServer.address() as { port: number }).port;
    const changedGraphResponse = await fetch(
      `http://127.0.0.1:${graphPort}/api/account/export`, { headers },
    );
    assert.equal(graphChanged, true);
    assert.equal(changedGraphResponse.status, 409,
      "a graph edit after the snapshot blocks delivery of formerly visible comments");
    assert.doesNotMatch(await changedGraphResponse.text(), /account-export-probe:hidden/);
  } finally {
    await new Promise<void>((resolve) => graphExportServer.close(() => resolve()));
  }
  const scopedExport = await fetch(accountExportUrl, { headers }).then((response) => response.json());
  assert.deepEqual(scopedExport.archives.map((item: { id: string }) => item.id), ["runtime-test"]);
  assert.deepEqual(scopedExport.archives[0].ownComments
    .filter((item: { text: string }) => item.text.startsWith("account-export-probe:"))
    .map((item: { text: string }) => item.text), ["account-export-probe:visible"],
  "a scoped member cannot export their old comment in a now-hidden branch");
  const ownerCommentExport = await fetch(accountExportUrl, { headers: ownerHeaders })
    .then((response) => response.json());
  assert.deepEqual(new Set(ownerCommentExport.archives.map((item: { id: string }) => item.id)),
    new Set(["runtime-test", "other-archive"]));
  assert.deepEqual(new Set(ownerCommentExport.archives.flatMap((archive: { ownComments: Array<{ text: string }> }) =>
    archive.ownComments.map((item) => item.text).filter((value) => value.startsWith("account-export-probe:")))),
  new Set(["account-export-probe:other-owner", "account-export-probe:root-owner"]),
  "the owner receives only their own comments across their current memberships");
  const scopedDocumentId = randomUUID();
  const scopedDocumentFile = `${randomUUID()}.pdf`;
  const scopedUploads = join(dirname(source), "uploads");
  writeFileSync(join(scopedUploads, scopedDocumentFile), "%PDF-1.4\nscoped-document-secret");
  await client.query(
    `INSERT INTO relations(id,ordinal,source,target,type)
     VALUES('document-access-parent',(SELECT COALESCE(max(ordinal),0)+1 FROM relations),
       'account-export-hidden','person-a','parent')`,
  );
  await client.query("UPDATE archives SET revision=revision+1 WHERE id='runtime-test'");
  await client.query(
    `INSERT INTO documents(id,ordinal,title,title_search,file_name,file_size,uploaded_by,created_at)
     VALUES($1,(SELECT COALESCE(max(ordinal),0)+1 FROM documents),
       'Scoped document','scoped document',$2,32,'owner',$3)`,
    [scopedDocumentId, scopedDocumentFile, new Date().toISOString()],
  );
  await client.query(
    "INSERT INTO document_people(document_id,person_id) VALUES($1,'account-export-hidden')",
    [scopedDocumentId],
  );
  const scopedDocumentPath = `/api/documents/${scopedDocumentId}/file`;
  const firstDocumentDownload = await fetch(securedBase + scopedDocumentPath, { headers });
  assert.equal(firstDocumentDownload.status, 200,
    "the scoped reader initially sees a document linked to an ancestor");
  assert.match(await firstDocumentDownload.text(), /scoped-document-secret/);
  const documentAuth = await createAuth(await userStore(app.archive.db), app.archive.db,
    process.env.PUBLIC_ORIGIN);
  const raceDocumentDownload = async (
    change: () => Promise<void>,
    path = scopedDocumentPath,
  ) => {
    let reachedRead!: () => void;
    let resumeRead!: () => void;
    const readReady = new Promise<void>((resolve) => { reachedRead = resolve; });
    const readGate = new Promise<void>((resolve) => { resumeRead = resolve; });
    const delayedArchive = {
      ...app!.archive,
      read: async () => {
        const snapshot = await app!.archive.read();
        reachedRead();
        await readGate;
        return snapshot;
      },
    };
    const download = documentsHttp({
      archive: delayedArchive,
      auth: documentAuth,
      media: mediaStore(scopedUploads),
      uploadsDirectory: scopedUploads,
    });
    const downloadServer = createServer((req, res) => {
      void download(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .catch((error) => { res.destroy(error); });
    });
    await new Promise<void>((resolve) => downloadServer.listen(0, "127.0.0.1", resolve));
    try {
      const port = (downloadServer.address() as { port: number }).port;
      const pending = fetch(`http://127.0.0.1:${port}${path}`, { headers });
      await Promise.race([
        readReady,
        pending.then(() => { throw new Error("Document sent before snapshot barrier"); }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Document read did not reach barrier")), 10_000);
          timer.unref();
        }),
      ]);
      await change();
      resumeRead();
      const response = await pending;
      assert.equal(response.status, 404,
        "a document hidden while preparing its download must not be delivered");
      assert.doesNotMatch(await response.text(), /scoped-document-secret/);
    } finally {
      resumeRead();
      await new Promise<void>((resolve) => downloadServer.close(() => resolve()));
    }
  };
  await raceDocumentDownload(async () => {
    await client.query("DELETE FROM relations WHERE id='document-access-parent'");
    await client.query("UPDATE archives SET revision=revision+1 WHERE id='runtime-test'");
  });
  await client.query(
    `INSERT INTO relations(id,ordinal,source,target,type)
     VALUES('document-access-parent',(SELECT COALESCE(max(ordinal),0)+1 FROM relations),
       'account-export-hidden','person-a','parent')`,
  );
  await client.query("UPDATE archives SET revision=revision+1 WHERE id='runtime-test'");
  const relinkedDocumentDownload = await fetch(securedBase + scopedDocumentPath, { headers });
  assert.equal(relinkedDocumentDownload.status, 200);
  assert.match(await relinkedDocumentDownload.text(), /scoped-document-secret/);
  await raceDocumentDownload(async () => {
    await client.query("DELETE FROM document_people WHERE document_id=$1", [scopedDocumentId]);
  });
  await client.query("DELETE FROM documents WHERE id=$1", [scopedDocumentId]);
  rmSync(join(scopedUploads, scopedDocumentFile));
  const scopedTiffId = randomUUID();
  const scopedTiffFile = `${randomUUID()}.tif`;
  const scopedTiff = await sampleTiff();
  writeFileSync(join(scopedUploads, scopedTiffFile), scopedTiff);
  await client.query(
    `INSERT INTO documents(id,ordinal,title,title_search,file_name,file_size,uploaded_by,created_at)
     VALUES($1,(SELECT COALESCE(max(ordinal),0)+1 FROM documents),
       'Scoped TIFF','scoped tiff',$2,$3,'owner',$4)`,
    [scopedTiffId, scopedTiffFile, scopedTiff.length, new Date().toISOString()],
  );
  await client.query(
    "INSERT INTO document_people(document_id,person_id) VALUES($1,'account-export-hidden')",
    [scopedTiffId],
  );
  const scopedTiffPages = `/api/documents/${scopedTiffId}/file?reader=pages`;
  const visibleTiffPages = await fetch(securedBase + scopedTiffPages, { headers });
  assert.equal(visibleTiffPages.status, 200);
  assert.equal((await visibleTiffPages.json()).pages.length, 3);
  await raceDocumentDownload(async () => {
    await client.query("DELETE FROM document_people WHERE document_id=$1", [scopedTiffId]);
  }, scopedTiffPages);
  await client.query("DELETE FROM documents WHERE id=$1", [scopedTiffId]);
  await client.query("DELETE FROM relations WHERE id='document-access-parent'");
  rmSync(join(scopedUploads, scopedTiffFile));
  const attachmentBytes = await sharp({
    create: { width: 3, height: 3, channels: 3, background: "blue" },
  }).png().toBuffer();
  const attachmentStore = discussionAttachmentStore(scopedUploads);
  const [attachment] = await attachmentStore.save([
    await prepareCommentFile("scoped-attachment.png", attachmentBytes),
  ]);
  const attachmentComment = await client.query(
    `INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text,attachments)
     VALUES('account-export-hidden','owner','Owner',$1,'Scoped attachment',$2::jsonb)
     RETURNING id`,
    [Date.now(), JSON.stringify([attachment])],
  );
  const attachmentId = Number(attachmentComment.rows[0].id);
  const attachmentPath = `/api/people/account-export-hidden/discussion/${attachmentId}/attachments/${attachment.id}`;
  await client.query(
    `INSERT INTO relations(id,ordinal,source,target,type)
     VALUES('attachment-access-parent',(SELECT COALESCE(max(ordinal),0)+1 FROM relations),
       'account-export-hidden','person-a','parent')`,
  );
  await client.query("UPDATE archives SET revision=revision+1 WHERE id='runtime-test'");
  const initialAttachment = await fetch(securedBase + attachmentPath, { headers });
  assert.equal(initialAttachment.status, 200);
  assert.deepEqual(Buffer.from(await initialAttachment.arrayBuffer()), attachmentBytes);
  const attachmentAuth = await createAuth(await userStore(app.archive.db), app.archive.db,
    process.env.PUBLIC_ORIGIN);
  const raceAttachmentDownload = async (path: string, change: () => Promise<void>) => {
    let reachedRead!: () => void;
    let resumeRead!: () => void;
    const readReady = new Promise<void>((resolve) => { reachedRead = resolve; });
    const readGate = new Promise<void>((resolve) => { resumeRead = resolve; });
    let reads = 0;
    const delayedArchive = {
      ...app!.archive,
      read: async () => {
        const snapshot = await app!.archive.read();
        if (reads++ === 0) {
          reachedRead();
          await readGate;
        }
        return snapshot;
      },
    };
    const handler = personDiscussionHttp({
      archive: delayedArchive,
      auth: attachmentAuth,
      uploadsDirectory: scopedUploads,
      media: mediaStore(scopedUploads),
      publicOrigin: process.env.PUBLIC_ORIGIN,
    });
    const downloadServer = createServer((req, res) => {
      void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .then((handled) => { if (!handled) res.writeHead(404).end(); })
        .catch((error) => { res.destroy(error); });
    });
    await new Promise<void>((resolve) => downloadServer.listen(0, "127.0.0.1", resolve));
    try {
      const port = (downloadServer.address() as { port: number }).port;
      const pending = fetch(`http://127.0.0.1:${port}${path}`, { headers });
      await Promise.race([
        readReady,
        pending.then(() => { throw new Error("Attachment sent before snapshot barrier"); }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Attachment read did not reach barrier")), 10_000);
          timer.unref();
        }),
      ]);
      await change();
      resumeRead();
      const response = await pending;
      assert.equal(response.status, 404,
        "an attachment hidden during preparation must not be delivered");
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
      assert.doesNotMatch(await response.text(), /scoped-attachment/);
    } finally {
      resumeRead();
      await new Promise<void>((resolve) => downloadServer.close(() => resolve()));
    }
  };
  await raceAttachmentDownload(attachmentPath, async () => {
    await client.query("DELETE FROM relations WHERE id='attachment-access-parent'");
    await client.query("UPDATE archives SET revision=revision+1 WHERE id='runtime-test'");
  });
  await client.query(
    `INSERT INTO relations(id,ordinal,source,target,type)
     VALUES('attachment-access-parent',(SELECT COALESCE(max(ordinal),0)+1 FROM relations),
       'account-export-hidden','person-a','parent')`,
  );
  await client.query("UPDATE archives SET revision=revision+1 WHERE id='runtime-test'");
  const initialPreview = await fetch(securedBase + attachmentPath + "/preview", { headers });
  assert.equal(initialPreview.status, 200);
  assert.equal(initialPreview.headers.get("content-type"), "image/webp");
  await initialPreview.arrayBuffer();
  await raceAttachmentDownload(attachmentPath + "/preview", async () => {
    await client.query("UPDATE archive_memberships SET approved=false WHERE user_id='reader'");
  });
  await client.query("UPDATE archive_memberships SET approved=true WHERE user_id='reader'");
  await client.query("DELETE FROM person_comments WHERE id=$1", [attachmentId]);
  await client.query("DELETE FROM relations WHERE id='attachment-access-parent'");
  await attachmentStore.remove([attachment]);
  const preparedCommentExport = await accountDataExport(app.archive.db).read("reader");
  assert.ok(preparedCommentExport);
  await client.query("UPDATE archive_memberships SET approved=false WHERE user_id='reader'");
  assert.equal(await accountDataExport(app.archive.db).canDeliver(
    "reader", preparedCommentExport.commentScopes), false,
  "a membership revoked during snapshot preparation cannot receive its old comments");
  const revokedCommentExport = await fetch(accountExportUrl, { headers })
    .then((response) => response.json());
  assert.equal(revokedCommentExport.archives[0].ownComments, null,
    "a revoked archive remains in the account directory without exposing its comments");
  await client.query(
    "UPDATE archive_memberships SET approved=true,tree_access='all',person_id=NULL WHERE user_id='reader'",
  );
  await client.query("DELETE FROM person_comments WHERE text LIKE 'account-export-probe:%'");
  await client.query("DELETE FROM people WHERE id='account-export-hidden'");
  await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
  await client.query("DELETE FROM person_comments WHERE text='account-export-probe:other-owner'");
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
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
  assert.equal((await fetch(otherBase + "/api/admin/published-people/batch/preview", {
    method: "POST", headers: inviteeHeaders,
    body: JSON.stringify({ action: "publish", personIds: ["person-a"], fields: selectedDiscoveryFields }),
  })).status, 403, "a reader cannot preview a private publication batch");
  assert.equal((await fetch(otherBase + "/api/admin/published-people/batch/preview", {
    method: "POST", headers,
    body: JSON.stringify({ action: "publish", personIds: ["person-a"], fields: selectedDiscoveryFields }),
  })).status, 401, "a member of a different archive cannot preview this publication batch");
  const batchPreviewUrl = otherBase + "/api/admin/published-people/batch/preview";
  const oldBatchPreview = await fetch(batchPreviewUrl, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ action: "publish", personIds: ["person-a"], fields: selectedDiscoveryFields }),
  });
  assert.equal(oldBatchPreview.status, 200);
  const oldReview = await oldBatchPreview.json();
  const beforeBatchRevision = await otherApp.archive.read();
  await otherApp.archive.write(beforeBatchRevision.family, beforeBatchRevision.revision);
  assert.equal((await fetch(otherBase + "/api/admin/published-people/batch", {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ personIds: ["person-a"], fields: selectedDiscoveryFields,
      revision: oldReview.revision, reviewToken: oldReview.reviewToken }),
  })).status, 409, "a PostgreSQL revision change invalidates an old publication review");
  const batchReview = await fetch(batchPreviewUrl, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ action: "publish", personIds: ["person-a"], fields: selectedDiscoveryFields }),
  });
  assert.equal(batchReview.status, 200);
  const reviewedPublication = await batchReview.json();
  assert.equal(reviewedPublication.people[0].person.birthSurname, "ПоискРождения");
  assert.equal((await fetch(otherBase + "/api/admin/published-people/batch", {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ personIds: ["person-a"], fields: selectedDiscoveryFields,
      revision: reviewedPublication.revision, reviewToken: reviewedPublication.reviewToken }),
  })).status, 200);
  await app!.archive.db.transaction(async () => {
    await app!.archive.db.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("runtime-test");
    assert.equal((await app!.archive.db.prepare("", `SELECT count(*)::int AS count FROM published_people
      WHERE archive_id='other-archive' AND person_id='person-a'`).get())?.count, 0,
    "RLS hides the other archive's publication row from this archive");
  }, true);
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
  const specialId = "family:человек.1";
  const specialSegment = encodeURIComponent(specialId);
  const specialBefore = await otherApp.archive.read();
  const specialFamily = structuredClone(specialBefore.family);
  specialFamily.people.push({ ...specialFamily.people[0], id: specialId,
    name: "Особый", surname: "Тестовый", patronymic: "", deceased: true,
    parents: [], spouses: [] });
  await otherApp.archive.write(specialFamily, specialBefore.revision);
  const specialDiscoveryUrl = securedBase + `/api/discovery/people/other-archive/${specialSegment}`;
  const specialAdminUrl = otherBase + `/api/admin/published-people/${specialSegment}`;
  assert.equal((await fetch(specialDiscoveryUrl, { headers })).status, 404,
    "a private card with punctuation and Unicode in its ID is absent from discovery");
  assert.equal((await fetch(specialAdminUrl, { method: "PUT", headers: inviteeHeaders })).status, 403,
    "a reader cannot publish a card through an encoded ID");
  assert.equal((await fetch(specialAdminUrl, { method: "PUT", headers })).status, 401,
    "another archive cannot publish the encoded ID");
  assert.equal((await fetch(specialAdminUrl, { method: "PUT", headers: ownerHeaders })).status, 200);
  const specialSearch = await fetch(securedBase + "/api/discovery/people?q=Особый", { headers });
  assert.equal(specialSearch.status, 200);
  assert.deepEqual((await specialSearch.json()).results.map((person: { id: string }) => person.id), [specialId]);
  const specialDetail = await fetch(specialDiscoveryUrl, { headers });
  assert.equal(specialDetail.status, 200);
  assert.equal((await specialDetail.json()).person.id, specialId);
  assert.equal((await fetch(otherBase + `/api/published-people/${specialSegment}`, {
    headers: ownerHeaders,
  })).status, 200, "the archive-local published card decodes the same ID");
  assert.equal((await fetch(otherBase + `/api/admin/published-people/batch?id=${specialSegment}`, {
    headers: ownerHeaders,
  })).status, 200, "batch status accepts a URL-encoded published ID");
  assert.equal((await fetch(otherBase + "/api/admin/published-people/batch/preview", {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ action: "unpublish", personIds: [specialId] }),
  })).status, 200, "batch preview accepts the same ID without changing publication");
  for (const invalid of ["family%2Fperson.1", "family%5Cperson.1", "family%252Fperson.1", "family%00person.1", "bad%"])
    assert.equal((await fetch(securedBase + `/api/discovery/people/other-archive/${invalid}`, {
      headers,
    })).status, 404, "unsafe encoded segments cannot reach another card");
  assert.equal((await fetch(specialAdminUrl, { method: "DELETE", headers: ownerHeaders })).status, 200);
  assert.equal((await fetch(specialDiscoveryUrl, { headers })).status, 404,
    "revoking publication immediately closes the formerly addressable card");
  assert.deepEqual((await (await fetch(securedBase + "/api/discovery/people?q=Особый", {
    headers,
  })).json()).results, []);
  const specialAfter = await otherApp.archive.read();
  const withoutSpecial = structuredClone(specialAfter.family);
  withoutSpecial.people = withoutSpecial.people.filter((person) => person.id !== specialId);
  await otherApp.archive.write(withoutSpecial, specialAfter.revision);
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
  const branchPath = matchPath + "/branch-share";
  const branchPersonPath = branchPath + "/people/branch-parent-b";
  const navigationHeaders = { ...ownerHeaders, "X-Real-IP": "198.51.100.214" };
  await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
  await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
    VALUES('other-archive','vk:42','admin',true,'all') ON CONFLICT (archive_id,user_id)
    DO UPDATE SET role='admin',approved=true,tree_access='all'`);
  await client.query(`INSERT INTO archive_owners(archive_id,user_id)
    VALUES('other-archive','vk:42') ON CONFLICT (archive_id) DO UPDATE SET user_id='vk:42'`);
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  await app.archive.db.prepare("", `UPDATE archive_memberships SET role='admin'
    WHERE archive_id='runtime-test' AND user_id='vk:42'`).run();
  assert.equal((await fetch(securedBase + branchPath, { headers: archiveAdminHeaders })).status,
    403, "an invited admin cannot grant or inspect the owner's branch");
  assert.equal((await fetch(securedBase + branchPath, {
    method: "PUT", headers: archiveAdminHeaders,
    body: JSON.stringify({ personIds: [], previewToken: "0".repeat(64) }),
  })).status, 403, "an invited admin cannot consent on the owner's behalf");
  await app.archive.db.prepare("", `UPDATE archive_memberships SET role='reader'
    WHERE archive_id='runtime-test' AND user_id='vk:42'`).run();
  assert.equal((await fetch(securedBase + branchPath, { headers: ownerHeaders })).status, 200);
  assert.equal((await fetch(otherBase + branchPath, { headers: ownerHeaders })).status, 403,
    "an invited admin of B cannot inspect its owner's branch");
  assert.equal((await fetch(securedBase + branchPath, { headers })).status, 403,
    "a reader cannot inspect branch grants even for a published linked card");
  assert.equal((await fetch(securedBase + branchPersonPath, { headers })).status, 403,
    "a reader cannot open a linked branch member by guessing the URL");
  assert.equal((await fetch(otherBase + branchPath, { headers })).status, 401,
    "a nonmember cannot inspect another archive's branch grant");
  for (const [runtime, visibleId, hiddenId, label] of [
    [app, "branch-parent-a", "branch-hidden-a", "Первый"],
    [otherApp, "branch-parent-b", "branch-hidden-b", "Второй"],
  ] as const) {
    const beforeBranch = await runtime.archive.read();
    const branchFamily = structuredClone(beforeBranch.family);
    if (runtime === otherApp) {
      branchFamily.people[0].occupation = "Местный исследователь";
      branchFamily.people[0].birthPlace = "Местный город";
    }
    branchFamily.people[0].parents = [visibleId, hiddenId];
    for (const [id, name] of [[visibleId, `${label} родитель`],
      [hiddenId, `${label} закрытый`]]) {
      branchFamily.people.push({ ...structuredClone(branchFamily.people[0]),
        id, name, birth: "1950", deceased: true, parents: [], spouses: [],
        biography: "Закрытая биография ветки", generation: 2 });
    }
    await runtime.archive.write(branchFamily, beforeBranch.revision);
    await publishedPeopleStore(runtime.archive.db).publish(visibleId, "owner");
  }
  const firstBranch = await fetch(securedBase + branchPath, { headers: ownerHeaders })
    .then((response) => response.json());
  const secondBranch = await fetch(otherBase + branchPath, { headers: archiveAdminHeaders })
    .then((response) => response.json());
  assert.deepEqual(firstBranch.available.map((person: { id: string }) => person.id), ["branch-parent-a"]);
  assert.deepEqual(secondBranch.available.map((person: { id: string }) => person.id), ["branch-parent-b"]);
  assert.equal(firstBranch.recipientArchiveId, "other-archive");
  assert.equal(secondBranch.recipientArchiveId, "runtime-test");
  assert.equal(firstBranch.ownExpiresAt, null);
  assert.doesNotMatch(JSON.stringify(firstBranch), /branch-hidden-a|Закрытая биография ветки/);
  assert.equal((await fetch(securedBase + branchPersonPath, { headers: navigationHeaders })).status,
    404, "a confirmed match without mutual branch grants cannot open a member URL");
  assert.equal((await fetch(securedBase + branchPath, {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ personIds: ["branch-hidden-a"], previewToken: firstBranch.previewToken,
      recipientArchiveId: "other-archive", durationDays: 7 }),
  })).status, 409, "an unpublished relative cannot be selected by guessing an ID");
  assert.equal((await fetch(securedBase + branchPath, {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ personIds: ["branch-parent-a"], previewToken: "0".repeat(64),
      recipientArchiveId: "other-archive", durationDays: 7 }),
  })).status, 409, "a stale preview cannot authorize a branch");
  assert.equal((await fetch(securedBase + branchPath, {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ personIds: ["branch-parent-a"], previewToken: firstBranch.previewToken,
      recipientArchiveId: "third-archive", durationDays: 7 }),
  })).status, 409, "the grant cannot address an archive outside the confirmed pair");
  assert.equal((await fetch(securedBase + branchPath, {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ personIds: ["branch-parent-a"], previewToken: firstBranch.previewToken,
      recipientArchiveId: "other-archive", durationDays: 365 }),
  })).status, 400, "a new grant must have one of the bounded durations");
  assert.equal((await fetch(securedBase + branchPath, {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ personIds: ["branch-parent-a"], previewToken: firstBranch.previewToken,
      recipientArchiveId: "other-archive", durationDays: 7 }),
  })).status, 200);
  assert.deepEqual((await fetch(otherBase + branchPath, { headers: archiveAdminHeaders })
    .then((response) => response.json())).incoming, [],
  "one archive's grant alone does not expose its branch");
  assert.equal((await fetch(securedBase + branchPersonPath, { headers: navigationHeaders })).status,
    404, "one unilateral grant cannot open the other archive's member card");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("runtime-test");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_members WHERE grantor_archive_id='other-archive'`).get())?.count,
      0, "A's own consent cannot read B's branch before B also consents");
  }, true);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_members WHERE grantor_archive_id='runtime-test'`).get())?.count,
      0, "RLS hides the other side's selected relatives until B also consents");
  }, true);
  assert.equal((await fetch(otherBase + branchPath, {
    method: "PUT", headers: archiveAdminHeaders,
    body: JSON.stringify({ personIds: ["branch-parent-b"], previewToken: secondBranch.previewToken,
      recipientArchiveId: "runtime-test", durationDays: 1 }),
  })).status, 200);
  const bilateralBranch = await fetch(securedBase + branchPath, { headers: ownerHeaders })
    .then((response) => response.json());
  assert.deepEqual(bilateralBranch.incoming.map((person: { id: string }) => person.id), ["branch-parent-b"]);
  assert.ok(bilateralBranch.ownExpiresAt,
    "new branch consent has a finite owner-visible expiry");
  const branchLifetimes = await matchDb.prepare("", `SELECT grantor_archive_id,
    extract(epoch FROM expires_at-now())/86400 AS days_left
    FROM discovery_branch_grants WHERE left_person_id='person-a'
      AND right_person_id='person-a'`).all();
  assert.ok(branchLifetimes.some((row) => row.grantor_archive_id === "runtime-test" &&
    Number(row.days_left) > 6.99 && Number(row.days_left) <= 7));
  assert.ok(branchLifetimes.some((row) => row.grantor_archive_id === "other-archive" &&
    Number(row.days_left) > 0.99 && Number(row.days_left) <= 1));
  assert.doesNotMatch(JSON.stringify(bilateralBranch), /branch-hidden-b|Закрытая биография ветки|sources|photo/);
  const selectedBranchResponse = await fetch(securedBase + branchPersonPath, { headers: navigationHeaders });
  assert.equal(selectedBranchResponse.status, 200);
  assert.match(selectedBranchResponse.headers.get("cache-control") || "", /no-store/);
  const selectedBranchPerson = (await selectedBranchResponse.json()).person;
  assert.deepEqual({ archiveId: selectedBranchPerson.archiveId, id: selectedBranchPerson.id,
    relation: selectedBranchPerson.relation },
  { archiveId: "other-archive", id: "branch-parent-b", relation: "parent" });
  assert.ok(Object.keys(selectedBranchPerson).every((key) =>
    ["archiveId", "id", "relation", "name", "birthYear", "deathYear", "birthPlace", "deathPlace"]
      .includes(key)), "member navigation exposes only the selected scalar projection");
  assert.doesNotMatch(JSON.stringify(selectedBranchPerson), /branch-hidden-b|Закрытая биография ветки|sources|photo/);
  assert.equal((await fetch(securedBase + branchPath + "/people/branch-hidden-b", {
    headers: navigationHeaders,
  })).status, 404, "a private adjacent person is indistinguishable from an unavailable member");
  assert.equal((await fetch(securedBase + branchPath + "/people/%ZZ", {
    headers: navigationHeaders,
  })).status, 404, "a malformed encoded ID exposes no branch detail");
  assert.equal((await fetch(securedBase + branchPath + "/people/branch-parent-a", {
    headers: navigationHeaders,
  })).status, 404, "the route cannot open the requester's own member as a foreign card");
  assert.equal((await fetch(securedBase + branchPersonPath, {
    method: "POST", headers: navigationHeaders,
  })).status, 405, "the linked member route is read-only");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("runtime-test");
    assert.equal((await matchDb.prepare("", `SELECT granted_by FROM discovery_branch_grants
      WHERE grantor_archive_id='other-archive' AND left_person_id='person-a'
        AND right_person_id='person-a'`).get())?.granted_by, "vk:42",
    "the recipient may inspect a still-active addressed branch grant");
  }, true);
  const expiryAHeaders = { ...ownerHeaders, "X-Real-IP": "198.51.100.216" };
  const expiryBHeaders = { ...archiveAdminHeaders, "X-Real-IP": "198.51.100.217" };
  assert.equal((await otherApp.archive.db.prepare("", `UPDATE discovery_branch_grants
    SET expires_at=now()-interval '1 second' WHERE grantor_archive_id='other-archive'
      AND left_person_id='person-a' AND right_person_id='person-a'`).run()).changes, 1);
  const expiredB = await fetch(securedBase + branchPath, { headers: expiryAHeaders })
    .then((response) => response.json());
  assert.equal(expiredB.ownReady, true);
  assert.equal(expiredB.otherReady, false);
  assert.deepEqual(expiredB.incoming, [], "B's expired consent closes A's branch view");
  assert.equal((await fetch(securedBase + branchPersonPath, { headers: expiryAHeaders })).status,
    404, "an expired source grant closes the direct member URL");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("runtime-test");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_grants WHERE grantor_archive_id='other-archive'
        AND left_person_id='person-a' AND right_person_id='person-a'`).get())?.count,
      0, "RLS hides the expired grant's author and timestamps from its recipient");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_members WHERE grantor_archive_id='other-archive'`).get())?.count,
      0, "RLS closes source members when their grant expires");
  }, true);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_grants WHERE grantor_archive_id='other-archive'
        AND left_person_id='person-a' AND right_person_id='person-a'`).get())?.count,
      1, "the grantor keeps its expired row to manage or renew consent");
  }, true);
  const expiredBPreview = await fetch(otherBase + branchPath, { headers: expiryBHeaders })
    .then((response) => response.json());
  assert.equal(expiredBPreview.ownReady, false);
  assert.equal((await fetch(otherBase + branchPath, {
    method: "PUT", headers: expiryBHeaders,
    body: JSON.stringify({ personIds: ["branch-parent-b"],
      previewToken: expiredBPreview.previewToken,
      recipientArchiveId: "runtime-test", durationDays: 30 }),
  })).status, 200, "B can renew only through a fresh explicit PUT");
  assert.deepEqual((await fetch(securedBase + branchPath, { headers: expiryAHeaders })
    .then((response) => response.json())).incoming.map((person: { id: string }) => person.id),
    ["branch-parent-b"]);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("runtime-test");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_grants WHERE grantor_archive_id='other-archive'
        AND left_person_id='person-a' AND right_person_id='person-a'`).get())?.count,
      1, "explicit renewal makes only the current grant visible again");
  }, true);
  assert.equal((await app.archive.db.prepare("", `UPDATE discovery_branch_grants
    SET expires_at=now()-interval '1 second' WHERE grantor_archive_id='runtime-test'
      AND left_person_id='person-a' AND right_person_id='person-a'`).run()).changes, 1);
  const expiredA = await fetch(otherBase + branchPath, { headers: expiryBHeaders })
    .then((response) => response.json());
  assert.equal(expiredA.otherReady, false);
  assert.deepEqual(expiredA.incoming, [], "A's expired consent also closes B's branch view");
  assert.equal((await fetch(otherBase + branchPath + "/people/branch-parent-a", {
    headers: expiryBHeaders,
  })).status, 404);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_grants WHERE grantor_archive_id='runtime-test'
        AND left_person_id='person-a' AND right_person_id='person-a'`).get())?.count,
      0, "the reverse recipient cannot inspect an expired source grant");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_members WHERE grantor_archive_id='runtime-test'`).get())?.count,
      0, "RLS closes recipient members when its own grant expires");
  }, true);
  const expiredAPreview = await fetch(securedBase + branchPath, { headers: expiryAHeaders })
    .then((response) => response.json());
  assert.equal((await fetch(securedBase + branchPath, {
    method: "PUT", headers: expiryAHeaders,
    body: JSON.stringify({ personIds: ["branch-parent-a"],
      previewToken: expiredAPreview.previewToken,
      recipientArchiveId: "other-archive", durationDays: 7 }),
  })).status, 200);
  assert.deepEqual((await fetch(otherBase + branchPath, { headers: expiryBHeaders })
    .then((response) => response.json())).incoming.map((person: { id: string }) => person.id),
    ["branch-parent-a"], "renewing both consents reopens only the selected member");
  await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
  await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
    VALUES('other-archive','other-only','admin',true,'all')`);
  const transferCardPath = matchPath + "/card-share";
  const grantBirth = async (base: string, grantHeaders: Record<string,string>) => {
    const previewResponse = await fetch(base + transferCardPath, { headers: grantHeaders });
    assert.equal(previewResponse.status, 200, "the current owner can preview a scalar grant");
    const preview = await previewResponse.json();
    assert.equal((await fetch(base + transferCardPath, {
      method: "PUT", headers: { ...grantHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: ["birth"], previewToken: preview.previewToken,
        recipientArchiveId: preview.recipientArchiveId, durationDays: 7 }),
    })).status, 200);
  };
  await grantBirth(securedBase, ownerHeaders);
  await grantBirth(otherBase, archiveAdminHeaders);
  assert.equal((await otherApp.archive.db.prepare("", `UPDATE discovery_linked_card_grants
    SET expires_at=now()-interval '1 second' WHERE grantor_archive_id='other-archive'
      AND left_person_id='person-a' AND right_person_id='person-a'`).run()).changes, 1);
  const recipientAfterReverseExpiry = await fetch(securedBase + transferCardPath, {
    headers: { ...ownerHeaders, "X-Real-IP": "198.51.100.221" },
  }).then((response) => response.json());
  assert.equal(recipientAfterReverseExpiry.incoming, null,
    "expiry also closes a B-to-A scalar snapshot");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("runtime-test");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_linked_card_grants WHERE grantor_archive_id='other-archive'
        AND left_person_id='person-a'`).get())?.count, 0,
    "RLS denies reverse-direction expired snapshots");
  }, true);
  await grantBirth(otherBase, { ...archiveAdminHeaders, "X-Real-IP": "198.51.100.222" });
  assert.equal((await client.query(`SELECT count(*)::int AS count
    FROM discovery_linked_card_grants WHERE left_person_id='person-a'`)).rows[0].count,
  2, "both owners can grant a private scalar snapshot for the confirmed pair");
  await client.query(`DROP TRIGGER revoke_discovery_card_grants_after_owner_transfer
    ON archive_owners`);
  await client.query(readFileSync(new URL("../../ops/postgres/061_discovery_copied_fields.sql", import.meta.url), "utf8"));
  assert.equal((await client.query(`SELECT count(*)::int AS count
    FROM discovery_linked_card_grants WHERE left_person_id='person-a'`)).rows[0].count,
  0, "installing 061 clears old scalar grants whose two-owner consent cannot be proven");
  await grantBirth(securedBase, ownerHeaders);
  await grantBirth(otherBase, archiveAdminHeaders);
  await client.query(readFileSync(new URL("../../ops/postgres/061_discovery_copied_fields.sql", import.meta.url), "utf8"));
  assert.equal((await client.query(`SELECT count(*)::int AS count
    FROM discovery_linked_card_grants WHERE left_person_id='person-a'`)).rows[0].count,
  2, "reapplying 061 cannot clear fresh grants after its transfer trigger exists");
  assert.equal((await fetch(otherBase + transferCardPath, {
    headers: otherOnlyHeaders,
  })).status, 403, "an invited admin cannot inspect the owner's scalar grants");
  assert.equal((await fetch(otherBase + transferCardPath, {
    method: "PUT", headers: { ...otherOnlyHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["birth"], previewToken: "0".repeat(64),
      recipientArchiveId: "runtime-test", durationDays: 7 }),
  })).status, 403, "an invited admin cannot issue a scalar grant");
  assert.equal((await fetch(otherBase + transferCardPath, {
    method: "DELETE", headers: otherOnlyHeaders,
  })).status, 403, "an invited admin cannot revoke the owner's scalar grant");
  assert.equal((await client.query(`UPDATE archive_owners SET user_id='other-only'
    WHERE archive_id='other-archive'`)).rowCount, 1);
  assert.equal((await client.query(`SELECT count(*)::int AS count
    FROM discovery_linked_card_grants WHERE left_person_id='person-a'`)).rows[0].count,
  0, "recipient ownership transfer revokes both its and the source's scalar grants atomically");
  assert.equal((await client.query("SELECT current_setting('drevo.archive_id') AS id")).rows[0].id,
    "other-archive", "recipient transfer restores its RLS context after deleting both grants");
  assert.equal((await fetch(otherBase + transferCardPath, {
    headers: archiveAdminHeaders,
  })).status, 403, "the former owner cannot inspect scalar grants after transfer");
  assert.equal((await client.query(`SELECT count(*)::int AS count
    FROM discovery_linked_pairs WHERE left_person_id='person-a'`)).rows[0].count, 1,
  "ownership transfer preserves the confirmed public link");
  await grantBirth(otherBase, otherOnlyHeaders);
  assert.deepEqual((await fetch(securedBase + transferCardPath, {
    headers: ownerHeaders,
  }).then((response) => response.json())).incoming.fields, { birth: "1990" },
  "the new owner can explicitly issue a fresh scalar grant");
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM discovery_branch_grants
    WHERE grantor_archive_id='other-archive' AND left_person_id='person-a'`)).rows[0].count,
    0, "ownership transfer revokes the previous owner's branch grant in the same transaction");
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM discovery_branch_members
    WHERE grantor_archive_id='runtime-test' AND left_person_id='person-a'`)).rows[0].count,
    0, "RLS closes A's branch members to B's successor before a new bilateral opt-in");
  assert.deepEqual((await fetch(securedBase + branchPath, { headers: {
    ...ownerHeaders, "X-Real-IP": "198.51.100.211",
  } }).then((response) => response.json())).incoming, [],
  "A cannot keep reading B's branch after B changes owner");
  assert.equal((await fetch(securedBase + branchPersonPath, { headers: {
    ...ownerHeaders, "X-Real-IP": "198.51.100.211",
  } })).status, 404, "ownership transfer closes direct member navigation");
  assert.equal((await fetch(otherBase + branchPath, { headers: {
    ...archiveAdminHeaders, "X-Real-IP": "198.51.100.212",
  } })).status, 403, "the former owner cannot reauthorize B's branch");
  assert.equal((await client.query(`UPDATE archive_owners SET user_id='vk:42'
    WHERE archive_id='other-archive'`)).rowCount, 1);
  assert.equal((await client.query(`SELECT count(*)::int AS count
    FROM discovery_linked_card_grants WHERE left_person_id='person-a'`)).rows[0].count,
  0, "transferring ownership back revokes the successor's grant too");
  await client.query(`DELETE FROM archive_memberships WHERE archive_id='other-archive'
    AND user_id='other-only'`);
  const afterTransfer = await fetch(otherBase + branchPath, { headers: {
    ...archiveAdminHeaders, "X-Real-IP": "198.51.100.212",
  } }).then((response) => response.json());
  assert.equal((await fetch(otherBase + branchPath, {
    method: "PUT", headers: { ...archiveAdminHeaders, "X-Real-IP": "198.51.100.212" },
    body: JSON.stringify({ personIds: ["branch-parent-b"], previewToken: afterTransfer.previewToken,
      recipientArchiveId: "runtime-test", durationDays: 7 }),
  })).status, 200, "the owner must issue a fresh grant after ownership changes back");
  assert.deepEqual((await fetch(securedBase + branchPath, { headers: {
    ...ownerHeaders, "X-Real-IP": "198.51.100.213",
  } }).then((response) => response.json())).incoming.map((person: { id: string }) => person.id),
  ["branch-parent-b"], "a fresh owner grant reopens only the selected branch member");
  assert.equal((await fetch(securedBase + branchPersonPath, { headers: {
    ...ownerHeaders, "X-Real-IP": "198.51.100.213",
  } })).status, 200, "a fresh mutual grant reopens the direct member URL");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_members WHERE grantor_archive_id='runtime-test'`).get())?.count,
      1, "RLS opens exactly the other side's selected member after mutual consent");
  }, true);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("unrelated-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count FROM discovery_branch_grants`).get())?.count,
      0, "RLS hides branch consent from a third archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count FROM discovery_branch_members`).get())?.count,
      0, "RLS hides branch members from a third archive");
  }, true);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    assert.equal((await matchDb.prepare("", `DELETE FROM discovery_branch_grants
      WHERE grantor_archive_id='runtime-test'`).run()).changes, 0,
    "the recipient cannot revoke the other archive's grant through SQL");
  });
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
  const runDiscoveryBackfill = async () => {
    const admin = process.env.PGADMINUSER
      ? new pg.Client({ user: process.env.PGADMINUSER, password: process.env.PGADMINPASSWORD })
      : client;
    if (admin !== client) await admin.connect();
    try {
      await admin.query(readFileSync(
        new URL("../../ops/postgres/backfill-discovery.sql", import.meta.url), "utf8"));
    } finally {
      if (admin !== client) await admin.end();
    }
  };
  await runDiscoveryBackfill();
  assert.deepEqual((await fetch(securedBase + branchPath, { headers: ownerHeaders })
    .then((response) => response.json())).incoming.map((person: { id: string }) => person.id),
    ["branch-parent-b"], "a backfill preserves current bilateral grants");
  assert.equal((await fetch(otherBase + branchPath, {
    method: "DELETE", headers: archiveAdminHeaders,
  })).status, 200);
  assert.deepEqual((await fetch(securedBase + branchPath, { headers: ownerHeaders })
    .then((response) => response.json())).incoming, [],
    "revoking either side closes the branch immediately");
  assert.equal((await fetch(securedBase + branchPersonPath, { headers: navigationHeaders })).status,
    404, "grant revocation closes an already issued member URL");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_members WHERE grantor_archive_id='runtime-test'`).get())?.count,
      0, "RLS closes the other side's members in the same revocation transaction");
  }, true);
  const refreshedSecondBranch = await fetch(otherBase + branchPath, { headers: archiveAdminHeaders })
    .then((response) => response.json());
  assert.equal((await fetch(otherBase + branchPath, {
    method: "PUT", headers: archiveAdminHeaders,
    body: JSON.stringify({ personIds: ["branch-parent-b"],
      previewToken: refreshedSecondBranch.previewToken,
      recipientArchiveId: "runtime-test", durationDays: 7 }),
  })).status, 200);
  // B-C is separately linked and mutually granted. It must never extend A-B.
  await client.query("SELECT set_config('drevo.archive_id','third-archive',false)");
  await client.query(`INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version)
    VALUES('third-archive','Third','',false,0,18)`);
  await client.query("INSERT INTO people(id,data) VALUES('person-c',$1)", [JSON.stringify({
    ...family.people[0], id: "person-c", name: "Третий", deceased: true,
  })]);
  await client.query("INSERT INTO people(id,data) VALUES('family:person.1',$1)", [JSON.stringify({
    ...family.people[0], id: "family:person.1", name: "Третий родитель", deceased: true,
  })]);
  const thirdDb = await openPostgresDatabase("third-archive", source);
  try {
    await publishedPeopleStore(thirdDb).publish("person-c", "owner");
    await publishedPeopleStore(thirdDb).publish("family:person.1", "owner");
  } finally { await thirdDb.close(); }
  await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
  const secondPairId = "11111111-2222-4333-8444-555555555555";
  await client.query(`INSERT INTO discovery_match_requests(id,left_archive_id,left_person_id,
    right_archive_id,right_person_id,initiated_by_archive_id,requested_by,status)
    VALUES($1,'other-archive','person-a','third-archive','person-c',
      'other-archive','owner','linked')`, [secondPairId]);
  await client.query(`INSERT INTO discovery_branch_grants(left_archive_id,left_person_id,
    right_archive_id,right_person_id,grantor_archive_id,granted_by)
    VALUES('other-archive','person-a','third-archive','person-c','other-archive','owner')`);
  await client.query(`INSERT INTO discovery_branch_members(left_archive_id,left_person_id,
    right_archive_id,right_person_id,grantor_archive_id,person_id,relation)
    VALUES('other-archive','person-a','third-archive','person-c',
      'other-archive','branch-parent-b','parent')`);
  await client.query("SELECT set_config('drevo.archive_id','third-archive',false)");
  await client.query(`INSERT INTO discovery_branch_grants(left_archive_id,left_person_id,
    right_archive_id,right_person_id,grantor_archive_id,granted_by)
    VALUES('other-archive','person-a','third-archive','person-c','third-archive','owner')`);
  await client.query(`INSERT INTO discovery_branch_members(left_archive_id,left_person_id,
    right_archive_id,right_person_id,grantor_archive_id,person_id,relation)
    VALUES('other-archive','person-a','third-archive','person-c',
      'third-archive','family:person.1','parent')`);
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM discovery_branch_grants
    WHERE left_archive_id='other-archive' AND right_archive_id='third-archive'
      AND expires_at IS NULL`)).rows[0].count, 2,
    "legacy grants without an expiry remain valid until revoked");
  await client.query(readFileSync(new URL("../../ops/postgres/062_discovery_branch_expiry.sql", import.meta.url), "utf8"));
  await client.query(readFileSync(new URL("../../ops/postgres/064_discovery_branch_grant_read_expiry.sql", import.meta.url), "utf8"));
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM discovery_branch_grants
    WHERE left_archive_id='other-archive' AND right_archive_id='third-archive'
      AND expires_at IS NULL`)).rows[0].count, 2,
    "reapplying 062/064 does not silently shorten existing branch consents");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("third-archive");
    assert.equal((await matchDb.prepare("", `SELECT granted_by FROM discovery_branch_grants
      WHERE left_archive_id='other-archive' AND right_archive_id='third-archive'
        AND grantor_archive_id='other-archive'`).get())?.granted_by, "owner",
      "recipient C can still read a legacy NULL grant under RLS after reapplying 064");
  }, true);
  const encodedMemberPath = `/api/discovery/matches/${secondPairId}/branch-share/people/family%3Aperson.1`;
  const encodedMember = await fetch(otherBase + encodedMemberPath, { headers: {
    ...archiveAdminHeaders, "X-Real-IP": "198.51.100.215",
  } });
  assert.equal(encodedMember.status, 200, "a selected member with punctuation has a usable direct URL");
  assert.deepEqual((await encodedMember.json()).person.id, "family:person.1");
  assert.equal((await fetch(securedBase + branchPath + "/people/family%3Aperson.1", {
    headers: navigationHeaders,
  })).status, 404, "A-B member navigation cannot traverse B-C's separately granted branch");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("runtime-test");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_members WHERE person_id='family:person.1'`).get())?.count,
      0, "RLS cannot expose C's selected member through A's unrelated confirmed pair");
  }, true);
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM discovery_branch_grants
    WHERE left_archive_id='other-archive' AND right_archive_id='runtime-test'`)).rows[0].count,
    0, "C cannot read grants belonging only to A-B even when it shares B-C");
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM discovery_branch_members
    WHERE left_archive_id='other-archive' AND right_archive_id='runtime-test'`)).rows[0].count,
    0, "C cannot inspect A-B members through its own link to B");
  const oneHopOnly = await fetch(securedBase + branchPath, { headers: ownerHeaders })
    .then((response) => response.json());
  assert.deepEqual(oneHopOnly.incoming.map((person: { id: string }) => person.id),
    ["branch-parent-b"], "A-B cannot traverse B-C or reveal C's branch");
  assert.doesNotMatch(JSON.stringify(oneHopOnly), /third-archive|family:person.1|Третий родитель/);
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
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
    [person.archiveId,person.id]), [["runtime-test","person-a"],["third-archive","person-c"]],
  "a signed-in reader sees only B's two directly confirmed published transitions");
  const firstPublicCard = await fetch(securedBase + "/api/discovery/people/runtime-test/person-a", {
    headers,
  }).then((response) => response.json());
  assert.deepEqual(firstPublicCard.linkedCards.map((person: { archiveId: string; id: string }) =>
    [person.archiveId,person.id]), [["other-archive","person-a"]],
  "A's public card cannot traverse B-C to C");
  const cardSharePath = `/api/discovery/matches/${matchBody.match.id}/card-share`;
  assert.equal((await fetch(securedBase + cardSharePath, { headers })).status, 403,
    "a reader of the published card cannot inspect private share grants");
  const shareBeforeEdit = await app.archive.read();
  const shareFamily = structuredClone(shareBeforeEdit.family);
  shareFamily.people[0].occupation = "Архивный исследователь";
  shareFamily.people[0].birthPlace = "Архивный город";
  shareFamily.people[0].biography = "Закрытая биография и источники";
  await app.archive.write(shareFamily,shareBeforeEdit.revision);
  assert.deepEqual((await fetch(otherBase + branchPath, { headers: archiveAdminHeaders })
    .then((response) => response.json())).incoming, [],
    "a family edit revokes the source archive's branch consent before another read");
  const renewedBranch = await fetch(securedBase + branchPath, { headers: ownerHeaders })
    .then((response) => response.json());
  assert.equal((await fetch(securedBase + branchPath, {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ personIds: ["branch-parent-a"],
      previewToken: renewedBranch.previewToken,
      recipientArchiveId: "other-archive", durationDays: 7 }),
  })).status, 200);
  const postEditBranchHeaders = { ...ownerHeaders, "X-Real-IP": "198.51.100.218" };
  assert.deepEqual((await fetch(securedBase + branchPath, { headers: postEditBranchHeaders })
    .then((response) => response.json())).incoming.map((person: { id: string }) => person.id),
    ["branch-parent-b"]);
  await publishedPeopleStore(otherApp.archive.db).unpublish("branch-parent-b");
  const branchAfterUnpublish = await fetch(securedBase + branchPath,
    { headers: postEditBranchHeaders });
  assert.equal(branchAfterUnpublish.headers.get("cache-control"), "private, no-store",
    "a reopened branch panel must revalidate against an uncached projection");
  assert.deepEqual((await branchAfterUnpublish.json()).incoming, [],
    "unpublishing a selected relative immediately removes it from the branch");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("runtime-test");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_members WHERE grantor_archive_id='other-archive'
        AND person_id='branch-parent-b'`).get())?.count, 0,
    "RLS cannot read the formerly shared member after publication is revoked");
  }, true);
  assert.equal((await fetch(securedBase + branchPersonPath, { headers: navigationHeaders })).status,
    404, "unpublishing immediately closes its direct linked member URL");
  const sharePreview = await fetch(securedBase + cardSharePath, { headers: ownerHeaders })
    .then((response) => response.json());
  const copyPreviewPath = cardSharePath + "/copy-preview";
  assert.equal((await fetch(securedBase + copyPreviewPath, { headers: ownerHeaders })).status,
    404, "the first side cannot preview a copy without the other's scalar grant");
  assert.equal((await fetch(otherBase + copyPreviewPath, { headers: ownerHeaders })).status,
    403, "an invited admin cannot inspect the owner's copy preview");
  assert.equal((await fetch(otherBase + copyPreviewPath, { headers: archiveAdminHeaders })).status,
    404, "the owner cannot preview a copy before the source grants fields");
  assert.equal(sharePreview.available.occupation, "Архивный исследователь");
  assert.equal(sharePreview.recipientArchiveId, "other-archive");
  assert.equal(sharePreview.recipientPersonName, "Тестов Исправленный кандидат",
    "the addressee is the currently published linked card, not a private archive label");
  assert.equal(sharePreview.available.biography, undefined);
  assert.equal(sharePreview.incoming, null);
  assert.equal(sharePreview.outgoing, null);
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["occupation"], previewToken: sharePreview.previewToken,
      recipientArchiveId: "third-archive", durationDays: 7 }),
  })).status, 409, "a scalar grant cannot address a third archive");
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["occupation"], previewToken: sharePreview.previewToken,
      recipientArchiveId: "other-archive", durationDays: 365 }),
  })).status, 400, "new scalar grants require a bounded term");
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["biography"], previewToken: sharePreview.previewToken,
      recipientArchiveId: "other-archive", durationDays: 7 }),
  })).status, 400, "free-form biography cannot enter a scalar card grant");
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["occupation"], previewToken: "0".repeat(64),
      recipientArchiveId: "other-archive", durationDays: 7 }),
  })).status, 409, "a stale card preview cannot authorize a new snapshot");
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["occupation", "birthPlace"],
      previewToken: sharePreview.previewToken,
      recipientArchiveId: "other-archive", durationDays: 7 }),
  })).status, 200);
  const incomingShare = await fetch(otherBase + cardSharePath, { headers: archiveAdminHeaders })
    .then((response) => response.json());
  assert.deepEqual(incomingShare.incoming.fields, {
    occupation: "Архивный исследователь", birthPlace: "Архивный город",
  });
  assert.equal(incomingShare.recipientArchiveId, "runtime-test");
  assert.ok(incomingShare.incoming.expiresAt);
  const initialScalarLife = await matchDb.prepare("", `SELECT
    extract(epoch FROM expires_at-now())/86400 AS days_left
    FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'
      AND left_person_id='person-a' AND right_person_id='person-a'`).get();
  assert.ok(Number(initialScalarLife?.days_left) > 6.99 && Number(initialScalarLife?.days_left) <= 7);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("unrelated-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_linked_card_grants WHERE left_person_id='person-a'
        AND right_person_id='person-a'`).get())?.count, 0,
    "a third archive cannot read an addressed scalar grant through SQL");
  }, true);
  const beforeScalarExpiry = await fetch(otherBase + copyPreviewPath, {
    headers: archiveAdminHeaders,
  }).then((response) => response.json());
  assert.equal((await app.archive.db.prepare("", `UPDATE discovery_linked_card_grants
    SET expires_at=now()-interval '1 second' WHERE grantor_archive_id='runtime-test'
      AND left_person_id='person-a' AND right_person_id='person-a'`).run()).changes, 1);
  const expiredCardHeaders = { ...archiveAdminHeaders, "X-Real-IP": "198.51.100.219" };
  const expiredCard = await fetch(otherBase + cardSharePath, { headers: expiredCardHeaders });
  assert.equal(expiredCard.status, 200);
  assert.equal(expiredCard.headers.get("cache-control"), "private, no-store");
  assert.equal((await expiredCard.json()).incoming, null,
    "an expired scalar grant closes the direct linked-card snapshot");
  assert.equal((await fetch(otherBase + copyPreviewPath, { headers: expiredCardHeaders })).status,
    404, "an expired scalar grant closes the copy-preview URL");
  assert.equal((await fetch(otherBase + copyPreviewPath, {
    method: "POST", headers: { ...expiredCardHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["birthPlace"], confirmConflicts: ["birthPlace"],
      revision: beforeScalarExpiry.revision, reviewToken: beforeScalarExpiry.reviewToken }),
  })).status, 404, "an expired grant cannot apply an earlier copy review");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'
        AND left_person_id='person-a'`).get())?.count, 0,
    "RLS hides an expired scalar snapshot from its recipient");
  }, true);
  const renewalHeaders = { ...ownerHeaders, "X-Real-IP": "198.51.100.220" };
  const renewalPreview = await fetch(securedBase + cardSharePath, { headers: renewalHeaders })
    .then((response) => response.json());
  assert.equal(renewalPreview.outgoing, null,
    "an expired owner grant is shown as inactive, not as an active snapshot");
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...renewalHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["occupation", "birthPlace"],
      previewToken: renewalPreview.previewToken,
      recipientArchiveId: "other-archive", durationDays: 30 }),
  })).status, 200, "the owner can renew the same fields with a new explicit term");
  assert.deepEqual((await fetch(otherBase + cardSharePath, { headers: expiredCardHeaders })
    .then((response) => response.json())).incoming.fields,
    { occupation: "Архивный исследователь", birthPlace: "Архивный город" });
  const renewedScalarLife = await matchDb.prepare("", `SELECT
    extract(epoch FROM expires_at-now())/86400 AS days_left
    FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'
      AND left_person_id='person-a' AND right_person_id='person-a'`).get();
  assert.ok(Number(renewedScalarLife?.days_left) > 29.99 && Number(renewedScalarLife?.days_left) <= 30);
  assert.doesNotMatch(JSON.stringify(incomingShare), /Закрытая биография|sources|parents/,
    "the grant response contains only the chosen scalar snapshot");
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',true)");
    await client.query(`INSERT INTO accounts(id,name,created_at)
      VALUES('card-transfer-successor','Card successor',now())`);
    await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
      VALUES('runtime-test','card-transfer-successor','admin',true,'all')`);
    await client.query("SAVEPOINT card_transfer_failure");
    await client.query(`CREATE FUNCTION public.reject_card_grant_revoke()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'card grant revoke blocked';
      END $$`);
    await client.query(`CREATE TRIGGER reject_card_grant_revoke
      BEFORE DELETE ON discovery_linked_card_grants FOR EACH ROW
      EXECUTE FUNCTION public.reject_card_grant_revoke()`);
    await assert.rejects(client.query(`UPDATE archive_owners
      SET user_id='card-transfer-successor' WHERE archive_id='runtime-test'`),
    /card grant revoke blocked/, "a failed grant revoke rolls back ownership transfer");
    await client.query("ROLLBACK TO SAVEPOINT card_transfer_failure");
    assert.equal((await client.query(`SELECT user_id FROM archive_owners
      WHERE archive_id='runtime-test'`)).rows[0].user_id, "owner");
    assert.equal((await client.query(`SELECT count(*)::int AS count
      FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'`)).rows[0].count,
    1, "failed transfer keeps the live source grant");
    assert.equal((await client.query("SELECT current_setting('drevo.archive_id') AS id")).rows[0].id,
      "runtime-test", "failed transfer restores the source RLS context");
    await client.query(`UPDATE archive_owners SET user_id='card-transfer-successor'
      WHERE archive_id='runtime-test'`);
    assert.equal((await client.query(`SELECT count(*)::int AS count
      FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'`)).rows[0].count,
    0, "source ownership transfer revokes its scalar grant atomically");
    assert.equal((await client.query("SELECT current_setting('drevo.archive_id') AS id")).rows[0].id,
      "runtime-test", "successful transfer restores the source RLS context");
    assert.equal((await client.query(`SELECT count(*)::int AS count
      FROM discovery_linked_pairs WHERE left_archive_id='other-archive'
        AND left_person_id='person-a' AND right_archive_id='runtime-test'
        AND right_person_id='person-a'`)).rows[0].count,
    1, "transfer does not revoke a previously confirmed public link");
  } finally {
    await client.query("ROLLBACK");
  }
  const copyPreviewResponse = await fetch(otherBase + copyPreviewPath, {
    headers: archiveAdminHeaders,
  });
  assert.equal(copyPreviewResponse.status, 200);
  assert.equal(copyPreviewResponse.headers.get("cache-control"), "private, no-store");
  const copyPreview = await copyPreviewResponse.json();
  assert.deepEqual({ source: copyPreview.source, target: copyPreview.target,
    fields: copyPreview.fields, quotaImpact: copyPreview.quotaImpact }, {
    source: { archiveId: "runtime-test", personId: "person-a" },
    target: { archiveId: "other-archive", personId: "person-a" },
    fields: [{ field: "birthPlace", sourceValue: "Архивный город",
      targetValue: "Местный город", status: "conflict", copyable: true },
    { field: "occupation", sourceValue: "Архивный исследователь",
      targetValue: "Местный исследователь", status: "conflict", copyable: false }],
    quotaImpact: { additionalPeople: 0, additionalMediaBytes: 0 },
  }, "the preview compares only permitted scalar values with the local linked card");
  assert.doesNotMatch(JSON.stringify(copyPreview), /Закрытая биография|sources|parents|photo/);
  assert.equal((await fetch(otherBase + copyPreviewPath, {
    method: "POST", headers: archiveAdminHeaders,
  })).status, 400, "applying a copy requires explicit selected fields and a fresh review");
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
    assert.equal(await matchDb.prepare("", `SELECT grantor_archive_id
      FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'
      FOR SHARE`).get(), undefined,
    "the recipient can read but cannot directly lock the grantor's row through UPDATE RLS");
    assert.equal((await matchDb.prepare("", `DELETE FROM discovery_linked_card_grants
      WHERE grantor_archive_id='runtime-test'`).run()).changes, 0,
    "the receiving archive cannot revoke the owner's grant through SQL");
  });
  await runDiscoveryBackfill();
  assert.equal((await matchDb.prepare("", `SELECT fields->>'occupation' AS occupation
    FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'`).get())?.occupation,
  "Архивный исследователь", "administrator backfill preserves a still-confirmed grant");
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',true)");
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES('share-grant-deleting','Share grant author',$1)",
      [new Date().toISOString()]);
    assert.equal((await client.query(`UPDATE discovery_linked_card_grants
      SET granted_by='share-grant-deleting' WHERE grantor_archive_id='runtime-test'
        AND left_person_id='person-a' RETURNING granted_by`)).rows[0]?.granted_by,
    "share-grant-deleting");
    await client.query("SELECT set_config('drevo.archive_id','other-archive',true)");
    assert.equal((await client.query(`UPDATE discovery_branch_grants
      SET granted_by='share-grant-deleting' WHERE grantor_archive_id='other-archive'
        AND left_person_id='person-a' AND right_person_id='person-a'
      RETURNING granted_by`)).rows[0]?.granted_by, "share-grant-deleting");
    await client.query("SELECT set_config('drevo.archive_id','unrelated-archive',true)");
    await client.query("SELECT set_config('drevo.account_id','share-grant-deleting',true)");
    await client.query("INSERT INTO deleted_account_tombstones(id) VALUES('share-grant-deleting')");
    await client.query("SELECT public.runtime_anonymize_deleted_account_history('share-grant-deleting')");
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',true)");
    assert.equal((await client.query(`SELECT granted_by FROM discovery_linked_card_grants
      WHERE grantor_archive_id='runtime-test' AND left_person_id='person-a'`)).rows[0]?.granted_by,
    "deleted-account", "account deletion anonymizes a grant even when the request archive differs");
    await client.query("SELECT set_config('drevo.archive_id','other-archive',true)");
    assert.equal((await client.query(`SELECT granted_by FROM discovery_branch_grants
      WHERE grantor_archive_id='other-archive' AND left_person_id='person-a'
        AND right_person_id='person-a'`)).rows[0]?.granted_by,
    "deleted-account", "account deletion also anonymizes bilateral branch grants");
  } finally {
    await client.query("ROLLBACK");
  }
  assert.equal((await matchDb.prepare("", `SELECT granted_by FROM discovery_linked_card_grants
    WHERE grantor_archive_id='runtime-test' AND left_person_id='person-a'`).get())?.granted_by,
  "owner", "the deletion probe leaves the live grant intact");
  const copyHeaders = { ...archiveAdminHeaders, "X-Real-IP": "198.51.100.216",
    "Content-Type": "application/json" };
  const targetBeforeRevision = await otherApp.archive.read();
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get("other-archive");
    await matchDb.prepare("", `UPDATE archives SET revision=revision+1
      WHERE id='other-archive'`).run();
  });
  const staleCopyResponse = await fetch(otherBase + copyPreviewPath, {
    method: "POST", headers: copyHeaders,
    body: JSON.stringify({ fields: ["birthPlace"], confirmConflicts: ["birthPlace"],
      revision: copyPreview.revision, reviewToken: copyPreview.reviewToken }),
  });
  assert.equal(staleCopyResponse.status, 409,
    `a target revision change invalidates an otherwise identical comparison: ${await staleCopyResponse.text()}`);
  const freshCopyPreviewResponse = await fetch(otherBase + copyPreviewPath, {
    headers: archiveAdminHeaders,
  });
  assert.equal(freshCopyPreviewResponse.status, 200);
  let freshCopyPreview = await freshCopyPreviewResponse.json();
  let copyBody = { fields: ["birthPlace"], confirmConflicts: ["birthPlace"],
    revision: freshCopyPreview.revision, reviewToken: freshCopyPreview.reviewToken };
  assert.equal((await fetch(otherBase + copyPreviewPath, {
    method: "POST", headers: { ...ownerHeaders, "X-Real-IP": "198.51.100.217" },
    body: JSON.stringify(copyBody),
  })).status, 403, "an invited admin cannot copy into the owner's linked card");
  assert.equal((await fetch(otherBase + copyPreviewPath, {
    method: "POST", headers: copyHeaders,
    body: JSON.stringify({ ...copyBody, fields: ["occupation"] }),
  })).status, 400, "occupation is visible for comparison but cannot be copied without provenance support");
  assert.equal((await fetch(otherBase + copyPreviewPath, {
    method: "POST", headers: copyHeaders,
    body: JSON.stringify({ ...copyBody, confirmConflicts: [] }),
  })).status, 409, "a conflicting local value requires separate explicit confirmation");
  assert.equal((await fetch(otherBase + copyPreviewPath, {
    method: "POST", headers: copyHeaders,
    body: JSON.stringify({ ...copyBody, reviewToken: "0".repeat(64) }),
  })).status, 409, "a stale review cannot replace a local value");
  let blockedCopy: Promise<Response> | undefined;
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get("runtime-test");
    await matchDb.prepare("", `SELECT fields FROM discovery_linked_card_grants
      WHERE grantor_archive_id='runtime-test' AND left_person_id='person-a'
      FOR UPDATE`).get();
    blockedCopy = fetch(otherBase + copyPreviewPath, { method: "POST",
      headers: { ...copyHeaders, "X-Real-IP": "198.51.100.219" },
      body: JSON.stringify(copyBody) });
    let waiting = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = await client.query(`SELECT 1 FROM pg_stat_activity
        WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%discovery_linked_card_grants%'
          AND query LIKE '%FOR SHARE%'`);
      if (result.rowCount) { waiting = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(waiting, true, "the copy holds its own archive lock while waiting for the live source grant");
    assert.equal((await matchDb.prepare("", `DELETE FROM discovery_linked_card_grants
      WHERE grantor_archive_id='runtime-test' AND left_person_id='person-a'`).run()).changes,
    1, "the grantor can revoke a grant during an in-flight copy");
  });
  assert.equal((await blockedCopy!).status, 404,
    "a concurrent grant revoke wins before the blocked copy can read source fields");
  assert.equal((await otherApp.archive.read()).family.people[0].birthPlace, "Местный город",
    "a copy blocked by revocation cannot change the receiving card");
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["occupation", "birthPlace"],
      previewToken: sharePreview.previewToken,
      recipientArchiveId: "other-archive", durationDays: 7 }),
  })).status, 200, "the source may grant the same scalar snapshot again");
  freshCopyPreview = await fetch(otherBase + copyPreviewPath, {
    headers: archiveAdminHeaders,
  }).then((response) => response.json());
  copyBody = { fields: ["birthPlace"], confirmConflicts: ["birthPlace"],
    revision: freshCopyPreview.revision, reviewToken: freshCopyPreview.reviewToken };
  const copyAttempts = await Promise.all([
    fetch(otherBase + copyPreviewPath, { method: "POST", headers: copyHeaders,
      body: JSON.stringify(copyBody) }),
    fetch(otherBase + copyPreviewPath, { method: "POST", headers: {
      ...copyHeaders, "X-Real-IP": "198.51.100.218",
    }, body: JSON.stringify(copyBody) }),
  ]);
  assert.deepEqual(copyAttempts.map((response) => response.status).sort(), [200, 409],
    "concurrent copies of one review commit once after the archive revision lock");
  const savedCopy = await copyAttempts.find((response) => response.status === 200)!.json();
  assert.deepEqual(savedCopy.copied, ["birthPlace"]);
  assert.equal(savedCopy.revision, freshCopyPreview.revision + 1);
  const copiedFamily = await otherApp.archive.read();
  assert.equal(copiedFamily.family.people[0].birthPlace, "Архивный город");
  assert.deepEqual(copiedFamily.family.people[0].sources,
    targetBeforeRevision.family.people[0].sources,
  "transfer provenance does not create or change genealogical citations");
  assert.equal(copiedFamily.family.people[0].occupation, "Местный исследователь",
    "copying a selected place cannot overwrite an unselected field");
  assert.equal((await app.archive.read()).family.people[0].birthPlace, "Архивный город",
    "the source card is never edited by the copy");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    const provenance = await matchDb.prepare("", `SELECT field,value,source_archive_id,
      source_person_id,copied_revision FROM discovery_copied_fields
      WHERE archive_id='other-archive' AND person_id='person-a'`).get();
    assert.deepEqual(provenance, { field: "birthPlace", value: "Архивный город",
      source_archive_id: "runtime-test", source_person_id: "person-a",
      copied_revision: savedCopy.revision },
    "the receiving archive retains transfer provenance separate from documentary citations");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count FROM history
      WHERE archive_id='other-archive' AND revision=?`).get(freshCopyPreview.revision))?.count,
    1, "the ordinary person patch path records undo history");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count FROM archive_audit_entries
      WHERE archive_id='other-archive' AND revision=? AND entity_id='person-a'`)
      .get(savedCopy.revision))?.count, 1, "the copy produces a normal person audit entry");
  }, true);
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('drevo.archive_id','other-archive',true)");
    await client.query("SET LOCAL search_path=pg_catalog");
    await client.query(`UPDATE public.people SET data=data
      WHERE archive_id='other-archive' AND id='person-a'`);
    assert.equal((await client.query(`SELECT value FROM public.discovery_copied_fields
      WHERE archive_id='other-archive' AND person_id='person-a'
        AND field='birthPlace'`)).rows[0]?.value, "Архивный город",
    "a person edit retains copy provenance even when maintenance changes search_path");
  } finally {
    await client.query("ROLLBACK");
  }
  for (const hiddenArchive of ["runtime-test", "unrelated-archive"])
    await matchDb.transaction(async () => {
      await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
        .get(hiddenArchive);
      assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
        FROM discovery_copied_fields WHERE archive_id='other-archive'`).get())?.count,
      0, "copy provenance is visible only to the receiving archive");
    }, true);
  await assert.rejects(matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get("runtime-test");
    await matchDb.prepare("", `INSERT INTO discovery_copied_fields(archive_id,person_id,
      field,value,source_archive_id,source_person_id,copied_revision)
      VALUES('other-archive','person-a','birthPlace','Подмена','runtime-test','person-a',1)`)
      .run();
  }), (error: unknown) => (error as { code?: string }).code === "42501",
  "the source archive cannot forge provenance in the recipient's tree");
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "DELETE", headers: ownerHeaders,
  })).status, 200);
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "DELETE", headers: ownerHeaders,
  })).status, 200, "repeated grant revocation is idempotent");
  const freshAfterGrantRevoke = await fetch(otherBase + cardSharePath, {
    headers: archiveAdminHeaders,
  });
  assert.equal(freshAfterGrantRevoke.status, 200);
  assert.equal(freshAfterGrantRevoke.headers.get("cache-control"), "private, no-store",
    "a re-opened panel must revalidate against an uncached grant response");
  assert.equal((await freshAfterGrantRevoke.json()).incoming, null,
    "revocation hides the snapshot from the other side immediately");
  assert.equal((await fetch(otherBase + copyPreviewPath, {
    headers: archiveAdminHeaders,
  })).status, 404, "a fresh copy preview closes immediately after grant revocation");
  assert.equal((await fetch(otherBase + copyPreviewPath, {
    method: "POST", headers: copyHeaders, body: JSON.stringify(copyBody),
  })).status, 404, "a revoked source grant cannot apply an older preview");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT value FROM discovery_copied_fields
      WHERE archive_id='other-archive' AND person_id='person-a' AND field='birthPlace'`)
      .get())?.value, "Архивный город",
    "revoking access does not erase an explicitly saved local copy");
  }, true);
  const beforeUnrelatedEdit = await otherApp.archive.read();
  const unrelatedEdit = structuredClone(beforeUnrelatedEdit.family);
  unrelatedEdit.people[0].occupation = "Другое занятие";
  await otherApp.archive.write(unrelatedEdit, beforeUnrelatedEdit.revision);
  const copiedValue = () => matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    return await matchDb.prepare("", `SELECT value FROM discovery_copied_fields
      WHERE archive_id='other-archive' AND person_id='person-a' AND field='birthPlace'`).get();
  }, true);
  assert.equal((await copiedValue())?.value, "Архивный город",
    "editing another field keeps copy provenance");
  const beforeCopiedValueEdit = await otherApp.archive.read();
  const copiedValueEdit = structuredClone(beforeCopiedValueEdit.family);
  copiedValueEdit.people[0].birthPlace = "Новое местное значение";
  await otherApp.archive.write(copiedValueEdit, beforeCopiedValueEdit.revision);
  assert.equal(await copiedValue(), undefined,
  "editing the copied value removes stale provenance without changing other facts");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'
        AND left_person_id='person-a'`).get())?.count, 0,
    "the recipient cannot read a formerly granted snapshot after revocation");
  }, true);
  assert.equal((await fetch(securedBase + cardSharePath, {
    method: "PUT", headers: { ...ownerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["occupation"], previewToken: sharePreview.previewToken,
      recipientArchiveId: "other-archive", durationDays: 7 }),
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
  // Keep later migration smoke checks on the original two-archive fixture.
  for (const runtime of [app, otherApp]) {
    const current = await runtime.archive.read();
    const restored = structuredClone(current.family);
    restored.people = restored.people.filter((person) => !person.id.startsWith("branch-"));
    restored.people[0].parents = restored.people[0].parents.filter((id) => !id.startsWith("branch-"));
    await runtime.archive.write(restored, current.revision);
  }
  await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
  assert.equal((await client.query("DELETE FROM discovery_match_requests WHERE id=$1", [secondPairId])).rowCount,
    1, "B removes its direct B-C test request before deleting C");
  await client.query("DELETE FROM archive_owners WHERE archive_id='other-archive' AND user_id='vk:42'");
  await client.query("DELETE FROM archive_memberships WHERE archive_id='other-archive' AND user_id='vk:42'");
  await client.query("SELECT set_config('drevo.archive_id','third-archive',false)");
  assert.equal((await client.query("DELETE FROM archives WHERE id='third-archive'")).rowCount,
    1, "C's FORCE RLS requires selecting C before fixture deletion");
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM discovery_people
    WHERE archive_id='third-archive'`)).rows[0].count, 0,
    "deleting the test archive also clears its public discovery projection");
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
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
  const recipientHeaders = { ...ownerHeaders, "X-Real-IP": "198.51.100.102" };
  const recipientCandidates = "/api/discovery/matches/candidates?sourcePersonId=person-b";
  assert.ok((await fetch(otherBase + recipientCandidates, { headers: recipientHeaders })
    .then((response) => response.json())).candidates.some((person: { id: string }) => person.id === "person-a"),
  "the receiving archive sees the suggested pair before rejecting a manual request");
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
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    const ignored = await matchDb.prepare("", `SELECT source_person_id,target_archive_id,
      target_person_id,ignored_by FROM discovery_ignored_candidates
      WHERE archive_id='other-archive' AND source_person_id='person-b'`).get();
    assert.deepEqual(ignored, { source_person_id: "person-b", target_archive_id: "runtime-test",
      target_person_id: "person-a", ignored_by: "owner" },
    "rejection stores the pair in the recipient's direction only");
  }, true);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("runtime-test");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_ignored_candidates WHERE archive_id='other-archive'`).get())?.count,
      0, "RLS hides the recipient's dismissal from the proposing archive");
  }, true);
  assert.ok(!(await fetch(otherBase + recipientCandidates, { headers: recipientHeaders })
    .then((response) => response.json())).candidates.some((person: { id: string }) => person.id === "person-a"),
  "rejection removes this pair from future automatic suggestions to the recipient");
  assert.ok((await fetch(otherBase + recipientCandidates + "&ignored=1", {
    headers: recipientHeaders,
  }).then((response) => response.json())).candidates.some((person: { id: string }) => person.id === "person-a"),
  "the dismissed pair remains recoverable in the recipient's hidden list");
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
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_ignored_candidates WHERE archive_id='other-archive'
        AND source_person_id='person-b' AND target_archive_id='runtime-test'
        AND target_person_id='person-a'`).get())?.count,
      1, "repeating a rejection keeps exactly one recipient-owned dismissal");
  }, true);
  assert.equal((await matchDb.prepare("", `SELECT decision_review_token FROM discovery_match_requests
    WHERE id=?`).get(rejectedId))?.decision_review_token, rejectedAudit?.decision_review_token);
  assert.equal((await fetch(securedBase + "/api/discovery/matches/ignored", {
    method: "POST", headers: manualHeaders,
    body: JSON.stringify({ sourcePersonId: "person-a", targetArchiveId: "other-archive",
      targetPersonId: "person-b", ignored: false }),
  })).status, 200, "the proposer may clear only its own directed ignore, not the recipient's");
  assert.ok(!(await fetch(otherBase + recipientCandidates, { headers: recipientHeaders })
    .then((response) => response.json())).candidates.some((person: { id: string }) => person.id === "person-a"));
  assert.equal((await fetch(otherBase + "/api/discovery/matches/ignored", {
    method: "POST", headers: recipientHeaders,
    body: JSON.stringify({ sourcePersonId: "person-b", targetArchiveId: "runtime-test",
      targetPersonId: "person-a", ignored: false }),
  })).status, 200);
  assert.ok((await fetch(otherBase + recipientCandidates, { headers: recipientHeaders })
    .then((response) => response.json())).candidates.some((person: { id: string }) => person.id === "person-a"),
  "restoring the hint resumes suggestions without changing the match decision");
  assert.equal((await fetch(otherBase + rejectedPath, {
    method: "PATCH", headers: manualHeaders, body: JSON.stringify({ decision: "reject" }),
  })).status, 200);
  assert.ok((await fetch(otherBase + recipientCandidates, { headers: recipientHeaders })
    .then((response) => response.json())).candidates.some((person: { id: string }) => person.id === "person-a"),
  "an idempotent retry cannot undo an explicit later restoration");
  const repeatedRequest = await fetch(otherBase + "/api/discovery/matches", {
    method: "POST", headers: recipientHeaders,
    body: JSON.stringify({ sourcePersonId: "person-b", targetArchiveId: "runtime-test",
      targetPersonId: "person-a" }),
  });
  assert.equal(repeatedRequest.status, 200);
  assert.deepEqual({ id: (await repeatedRequest.json()).match.id,
    status: (await matchDb.prepare("", "SELECT status FROM discovery_match_requests WHERE id=?")
      .get(rejectedId))?.status }, { id: rejectedId, status: "rejected" },
  "restoring a hint does not reopen the rejected manual request");
  const beforeReverseRejection = await app.archive.read();
  const reverseFamily = structuredClone(beforeReverseRejection.family);
  reverseFamily.people.push({ ...structuredClone(reverseFamily.people[0]),
    id: "reverse-rejected-a", name: "Другой Иван", column: 75 });
  const reverseWrite = await app.archive.write(reverseFamily, beforeReverseRejection.revision);
  await publishedPeopleStore(app.archive.db).publish("reverse-rejected-a", "owner");
  const reverseRequest = await fetch(otherBase + "/api/discovery/matches", {
    method: "POST", headers: recipientHeaders,
    body: JSON.stringify({ sourcePersonId: "person-b", targetArchiveId: "runtime-test",
      targetPersonId: "reverse-rejected-a" }),
  });
  assert.equal(reverseRequest.status, 200);
  const reverseId = (await reverseRequest.json()).match.id as string;
  assert.equal((await fetch(securedBase + `/api/discovery/matches/${reverseId}`, {
    method: "PATCH", headers: manualHeaders, body: JSON.stringify({ decision: "reject" }),
  })).status, 200);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("runtime-test");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_ignored_candidates WHERE archive_id='runtime-test'
        AND source_person_id='reverse-rejected-a' AND target_archive_id='other-archive'
        AND target_person_id='person-b'`).get())?.count, 1,
    "when the recipient is the right pair side, the ignore still points from its own person");
  }, true);
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
      FROM discovery_ignored_candidates WHERE archive_id='runtime-test'
        AND source_person_id='reverse-rejected-a'`).get())?.count, 0,
    "the initiator cannot read the reverse-direction dismissal");
  }, true);
  assert.equal((await fetch(securedBase + "/api/discovery/matches/ignored", {
    method: "POST", headers: manualHeaders,
    body: JSON.stringify({ sourcePersonId: "reverse-rejected-a",
      targetArchiveId: "other-archive", targetPersonId: "person-b", ignored: false }),
  })).status, 200);
  assert.equal((await matchDb.prepare("", "SELECT status FROM discovery_match_requests WHERE id=?")
    .get(reverseId))?.status, "rejected", "restoration does not reopen the reverse manual request");
  await app.archive.write(beforeReverseRejection.family, reverseWrite.revision);
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
  const revocableSharePath = revocablePath + "/card-share";
  const revocablePreview = await fetch(securedBase + revocableSharePath, { headers: manualHeaders })
    .then((response) => response.json());
  assert.equal(revocablePreview.available.birth, "1960");
  assert.equal((await fetch(securedBase + revocableSharePath, {
    method: "PUT", headers: { ...manualHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: ["birth"], previewToken: revocablePreview.previewToken,
      recipientArchiveId: revocablePreview.recipientArchiveId, durationDays: 7 }),
  })).status, 200);
  assert.equal((await app.archive.db.prepare("", `UPDATE discovery_linked_card_grants
    SET expires_at=NULL WHERE grantor_archive_id='runtime-test'
      AND left_person_id=? AND right_person_id=?`).run(parent.id,parent.id)).changes, 1);
  await client.query(readFileSync(new URL("../../ops/postgres/063_discovery_card_expiry.sql", import.meta.url), "utf8"));
  assert.equal((await client.query(`SELECT count(*)::int AS count
    FROM discovery_linked_card_grants WHERE left_person_id=$1 AND right_person_id=$2
      AND expires_at IS NULL`, [parent.id,parent.id])).rows[0].count, 1,
  "reapplying 063 never shortens a legacy until-revoked scalar consent");
  const legacyCardResponse = await fetch(securedBase + revocableSharePath, {
    headers: manualHeaders,
  });
  assert.equal(legacyCardResponse.status, 200,
    "the grantor can still manage a legacy scalar consent");
  assert.equal((await legacyCardResponse.json()).outgoing.expiresAt, null,
    "the API labels a legacy scalar grant as valid until revoked");
  await matchDb.transaction(async () => {
    await matchDb.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("other-archive");
    assert.equal((await matchDb.prepare("", `SELECT fields->>'birth' AS birth
      FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'
        AND left_person_id=? AND right_person_id=?`).get(parent.id,parent.id))?.birth,
      "1960", "the recipient's SQL RLS keeps a legacy NULL grant readable until revoke");
  }, true);
  assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
    FROM discovery_linked_card_grants WHERE left_person_id=? AND right_person_id=?`)
    .get(parent.id,parent.id))?.count, 1);
  const publicParentPath = `/api/discovery/people/runtime-test/${parent.id}`;
  const linkedPublicParent = await fetch(securedBase + publicParentPath, { headers });
  assert.equal(linkedPublicParent.status, 200);
  assert.equal(linkedPublicParent.headers.get("cache-control"), "private, no-store");
  assert.equal((await linkedPublicParent.json()).linkedCards.length, 1);
  assert.equal((await fetch(securedBase + revocablePath, {
    method: "PATCH", headers: manualHeaders, body: JSON.stringify({ decision: "revoke" }),
  })).status, 200);
  assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
    FROM discovery_linked_card_grants WHERE left_person_id=? AND right_person_id=?`)
    .get(parent.id,parent.id))?.count, 0,
  "manually revoking the match removes its extra-field grant atomically");
  assert.equal((await fetch(securedBase + revocableSharePath, {
    headers: manualHeaders,
  })).status, 404, "the former grantor cannot reopen a revoked linked card");
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
  const revokedPublicParent = await fetch(securedBase + publicParentPath, { headers });
  assert.equal(revokedPublicParent.status, 200, "the still-published card remains public");
  assert.equal(revokedPublicParent.headers.get("cache-control"), "private, no-store");
  assert.deepEqual((await revokedPublicParent.json()).linkedCards, [],
    "a fresh public GET cannot return a revoked linked-card transition");
  const relativeHint = (await signalIds()).find((item) => item.id === "relative-only");
  assert.ok(relativeHint?.reasons.includes("Совпадает опубликованный близкий родственник"));
  assert.doesNotMatch(JSON.stringify(relativeHint), /Пётр|Орлов|closed-relative/,
    "candidate evidence contains no relative names or private card identifiers");
  assert.equal((await app.archive.db.prepare("", `SELECT count(*)::int AS count
    FROM discovery_relative_names WHERE relative_person_id='closed-relative'`).get())?.count, 0);
  const publicSearchHeaders = { ...headers, "X-Real-IP": "198.51.100.211" };
  const publicParentResults = async () => {
    const response = await fetch(securedBase +
      `/api/discovery/people?q=${encodeURIComponent("Орлов")}`, { headers: publicSearchHeaders });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return (await response.json()).results as { archiveId: string; id: string }[];
  };
  assert.equal((await publicParentResults()).some((item) =>
    item.archiveId === "other-archive" && item.id === parent.id), true);
  await otherPublication.unpublish(parent.id);
  assert.equal((await publicParentResults()).some((item) =>
    item.archiveId === "other-archive" && item.id === parent.id), false,
  "a fresh indexed search cannot return a withdrawn publication");
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
    FROM discovery_branch_grants WHERE left_person_id='person-a'
      AND right_person_id='person-a'`).get())?.count, 0,
    "unpublishing a linked root atomically removes both branch grants");
  assert.equal((await fetch(securedBase + branchPath, { headers: {
    ...ownerHeaders, "X-Real-IP": "198.51.100.210",
  } })).status, 404,
    "a revoked link cannot reopen the previously granted branch");
  assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
    FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'`).get())?.count, 0,
  "removing either publication revokes the extra-field grant in the same transaction");
  assert.equal((await fetch(securedBase + cardSharePath, { headers: ownerHeaders })).status, 404,
    "a revoked match cannot be used to read the old card snapshot");
  await runDiscoveryBackfill();
  assert.equal((await matchDb.prepare("", `SELECT count(*)::int AS count
    FROM discovery_linked_card_grants WHERE grantor_archive_id='runtime-test'`).get())?.count, 0,
  "backfill does not resurrect grants after publication revocation");
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
  const specialSourceId = "family:человек.1";
  const specialTargetId = "ветка:person.2";
  const ownSpecialBefore = await app.archive.read();
  const ownSpecialFamily = structuredClone(ownSpecialBefore.family);
  ownSpecialFamily.people.push({ ...structuredClone(ownSpecialFamily.people[0]),
    id: specialSourceId, name: "Софья", surname: "Редкая", patronymic: "",
    birth: "1900", death: "1980", deceased: true, parents: [], spouses: [], column: 54 });
  await app.archive.write(ownSpecialFamily, ownSpecialBefore.revision);
  const otherSpecialBefore = await otherApp.archive.read();
  const otherSpecialFamily = structuredClone(otherSpecialBefore.family);
  otherSpecialFamily.people.push({ ...structuredClone(otherSpecialFamily.people[0]),
    id: specialTargetId, name: "Софья", surname: "Редкая", patronymic: "",
    birth: "1900", death: "1980", deceased: true, parents: [], spouses: [], column: 54 });
  await otherApp.archive.write(otherSpecialFamily, otherSpecialBefore.revision);
  await publishedPeopleStore(app.archive.db).publish(specialSourceId, "owner");
  await otherPublication.publish(specialTargetId, "owner");
  const specialMatchHeaders = { ...ownerHeaders, "X-Real-IP": "198.51.100.241" };
  const specialCandidateUrl = securedBase + "/api/discovery/matches/candidates?sourcePersonId=" +
    encodeURIComponent(specialSourceId);
  assert.equal((await fetch(specialCandidateUrl, { headers })).status, 403,
    "a reader cannot inspect candidates for a Unicode source ID");
  assert.equal((await fetch(otherBase + "/api/discovery/matches/candidates?sourcePersonId=" +
    encodeURIComponent(specialSourceId), { headers: specialMatchHeaders })).status, 404,
  "another archive cannot use a published source ID as its own");
  const specialCandidates = await fetch(specialCandidateUrl, { headers: specialMatchHeaders });
  assert.equal(specialCandidates.status, 200);
  assert.ok((await specialCandidates.json()).candidates.some((candidate: { id: string }) =>
    candidate.id === specialTargetId), "indexed candidates include an explicitly published Unicode target ID");
  const specialIgnoreBody = (ignored: boolean) => JSON.stringify({
    sourcePersonId: specialSourceId, targetArchiveId: "other-archive",
    targetPersonId: specialTargetId, ignored,
  });
  assert.equal((await fetch(securedBase + "/api/discovery/matches/ignored", {
    method: "POST", headers, body: specialIgnoreBody(true),
  })).status, 403, "a reader cannot ignore a candidate through a Unicode ID");
  assert.equal((await fetch(securedBase + "/api/discovery/matches/ignored", {
    method: "POST", headers: specialMatchHeaders, body: specialIgnoreBody(true),
  })).status, 200);
  assert.equal((await fetch(specialCandidateUrl, { headers: specialMatchHeaders })
    .then((response) => response.json())).candidates.some((candidate: { id: string }) =>
    candidate.id === specialTargetId), false, "ignoring hides only this suggested pair");
  assert.equal((await fetch(securedBase + "/api/discovery/matches/ignored", {
    method: "POST", headers: specialMatchHeaders, body: specialIgnoreBody(false),
  })).status, 200);
  assert.ok((await fetch(specialCandidateUrl, { headers: specialMatchHeaders })
    .then((response) => response.json())).candidates.some((candidate: { id: string }) =>
    candidate.id === specialTargetId), "restoring shows the same suggested pair");
  const specialRequestBody = JSON.stringify({ sourcePersonId: specialSourceId,
    targetArchiveId: "other-archive", targetPersonId: specialTargetId });
  assert.equal((await fetch(securedBase + "/api/discovery/matches", {
    method: "POST", headers, body: specialRequestBody,
  })).status, 403, "a reader cannot submit a Unicode-ID match request");
  const specialRequest = await fetch(securedBase + "/api/discovery/matches", {
    method: "POST", headers: specialMatchHeaders, body: specialRequestBody,
  });
  assert.equal(specialRequest.status, 200);
  const specialMatchId = (await specialRequest.json()).match.id as string;
  const specialReverseRequest = await fetch(otherBase + "/api/discovery/matches", {
    method: "POST", headers: specialMatchHeaders,
    body: JSON.stringify({ sourcePersonId: specialTargetId,
      targetArchiveId: "runtime-test", targetPersonId: specialSourceId }),
  });
  assert.equal(specialReverseRequest.status, 200);
  assert.equal((await specialReverseRequest.json()).match.id, specialMatchId,
    "a reverse request with both Unicode IDs reuses the same pair");
  assert.equal((await fetch(securedBase + `/api/discovery/matches/${specialMatchId}`, {
    method: "PATCH", headers: specialMatchHeaders, body: JSON.stringify({ decision: "revoke" }),
  })).status, 200);
  await otherPublication.unpublish(specialTargetId);
  assert.equal((await fetch(specialCandidateUrl, { headers: specialMatchHeaders })
    .then((response) => response.json())).candidates.some((candidate: { id: string }) =>
    candidate.id === specialTargetId), false,
  "revoking the target publication removes its suggestion immediately");
  await publishedPeopleStore(app.archive.db).unpublish(specialSourceId);
  assert.equal((await fetch(specialCandidateUrl, { headers: specialMatchHeaders })).status, 404,
    "revoking the source publication closes its candidate endpoint");
  const ownSpecialAfter = await app.archive.read();
  const ownWithoutSpecial = structuredClone(ownSpecialAfter.family);
  ownWithoutSpecial.people = ownWithoutSpecial.people.filter((person) => person.id !== specialSourceId);
  await app.archive.write(ownWithoutSpecial, ownSpecialAfter.revision);
  const otherSpecialAfter = await otherApp.archive.read();
  const otherWithoutSpecial = structuredClone(otherSpecialAfter.family);
  otherWithoutSpecial.people = otherWithoutSpecial.people.filter((person) => person.id !== specialTargetId);
  await otherApp.archive.write(otherWithoutSpecial, otherSpecialAfter.revision);
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
    const personalArchiveId = location.split("/")[2];
    const selectedDbPath = join(directory, "archives", personalArchiveId, "source.sqlite");
    const setOwnerApproved = async (approved: boolean) => {
      await client.query("SELECT set_config('drevo.archive_id',$1,false)", [personalArchiveId]);
      const changed = await client.query(
        "UPDATE archive_memberships SET approved=$1 WHERE archive_id=$2 AND user_id=$3",
        [approved, personalArchiveId, newAccountSession.user.id],
      );
      assert.equal(changed.rowCount, 1);
    };
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
    const exportArchive = await openArchive(selectedDbPath, family, personalArchiveId);
    const portableAuth = await createAuth(await userStore(exportArchive.db), exportArchive.db,
      process.env.PUBLIC_ORIGIN);
    let exportReady!: () => void;
    let releaseExport!: () => void;
    const exportReached = new Promise<void>((resolve) => { exportReady = resolve; });
    const exportGate = new Promise<void>((resolve) => { releaseExport = resolve; });
    const delayedPortableExport = portableExportHttp(
      exportArchive, portableAuth, join(dirname(selectedDbPath), "uploads"),
      async () => { exportReady(); await exportGate; },
    );
    const portableExportServer = createServer((req, res) => {
      void delayedPortableExport(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .catch((error) => { res.destroy(error); });
    });
    await new Promise<void>((resolve) => portableExportServer.listen(0, "127.0.0.1", resolve));
    const portableExportBase = `http://127.0.0.1:${(portableExportServer.address() as { port: number }).port}`;
    try {
      await setOwnerApproved(false);
      assert.equal((await fetch(portableExportBase + "/api/drevo/export", {
        headers: { Cookie: sessionCookie },
      })).status, 403, "an unapproved owner cannot start a portable export");
      await setOwnerApproved(true);
      const pending = fetch(portableExportBase + "/api/drevo/export", {
        headers: { Cookie: sessionCookie },
      });
      let timer!: ReturnType<typeof setTimeout>;
      const progress = await Promise.race([
        exportReached.then(() => "ready"),
        pending.then(() => "responded"),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timed out"), 10_000); }),
      ]);
      clearTimeout(timer);
      assert.equal(progress, "ready", "portable export must reach the pre-send barrier");
      await setOwnerApproved(false);
      releaseExport();
      const denied = await pending;
      assert.equal(denied.status, 403, "revoking approval before the first byte blocks export");
      assert.notEqual((await denied.text()).slice(0, 2), "PK");
    } finally {
      releaseExport();
      await setOwnerApproved(true);
      portableExportServer.closeAllConnections();
      await new Promise<void>((resolve) => portableExportServer.close(() => resolve()));
      await exportArchive.close();
    }
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
    const portableDocumentId = "ae972b95-dd27-4a03-beb4-5239df77f48a";
    const portableAnnotationId = "9818d273-466c-4732-a5f4-c79e358cf70d";
    writeFileSync(join(directory, "portable-record.pdf"), "%PDF-1.4\nportable document");
    await writePortablePackage(createWriteStream(importFile), directory, {
      family: {
        title: "Transferred", description: "", demo: false,
        people: [{ id: "pg-portable-person", name: "Portable", surname: "Person",
          patronymic: "", sex: "u", birth: "1900", birthPlace: "",
          parents: [], spouses: [], generation: 1, column: 0, sources: [],
          createdBy: "owner" }],
        photos: [],
      },
      documents: [{ id: portableDocumentId, title: "Portable record",
        fileName: "portable-record.pdf", uploadedBy: "owner",
        createdAt: "2026-09-30T00:00:00Z", documentType: "", documentDate: "",
        place: "", description: "", provenance: "", personIds: ["pg-portable-person"],
        annotations: [{ id: portableAnnotationId, page: 1, x: 0.1, y: 0.1,
          width: 0.2, height: 0.2, text: "Source note", authorId: "owner",
          authorName: "Original researcher", createdAt: "2026-09-30T00:00:00Z" }] }],
      comments: [{ id: 1, personId: "pg-portable-person", authorId: "owner",
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
    const previewArchive = await openArchive(selectedDbPath, family, personalArchiveId);
    const previewAuth = await createAuth(await userStore(previewArchive.db), previewArchive.db,
      process.env.PUBLIC_ORIGIN);
    let previewReadReady!: () => void;
    let releasePreviewRead!: () => void;
    const previewReadReached = new Promise<void>((resolve) => { previewReadReady = resolve; });
    const previewReadGate = new Promise<void>((resolve) => { releasePreviewRead = resolve; });
    const delayedPreview = portableImportHttp({
      ...previewArchive,
      read: async () => {
        const snapshot = await previewArchive.read();
        previewReadReady();
        await previewReadGate;
        return snapshot;
      },
    }, previewAuth, selectedDbPath, process.env.PUBLIC_ORIGIN);
    const previewServer = createServer((req, res) => {
      void delayedPreview.handle(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .catch((error) => { res.destroy(error); });
    });
    await new Promise<void>((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
    try {
      const previewBase = `http://127.0.0.1:${(previewServer.address() as { port: number }).port}`;
      const pending = fetch(previewBase + "/api/drevo/preview", {
        method: "POST", headers: transferHeaders, body: readFileSync(importFile),
      });
      let timer!: ReturnType<typeof setTimeout>;
      const progress = await Promise.race([
        previewReadReached.then(() => "read"),
        pending.then(() => "responded"),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timed out"), 10_000); }),
      ]);
      clearTimeout(timer);
      assert.equal(progress, "read", "portable preview must reach the gated archive read");
      await setOwnerApproved(false);
      releasePreviewRead();
      assert.equal((await pending).status, 403,
        "a revoked owner cannot receive a completed preview");
      assert.equal((await previewArchive.db.prepare("", "SELECT count(*)::int AS n FROM workflow_stages WHERE kind='drevo'")
        .get())?.n, 0, "a revoked preview removes its stage");
      assert.deepEqual(readdirSync(join(dirname(selectedDbPath), "staging", "portable"))
        .filter((name) => /^[a-f0-9-]{36}$/.test(name)), [],
      "a revoked preview removes staged files");
    } finally {
      releasePreviewRead();
      await setOwnerApproved(true);
      previewServer.closeAllConnections();
      await new Promise<void>((resolve) => previewServer.close(() => resolve()));
      await delayedPreview.close();
      await previewArchive.close();
    }
    const previewTransfer = await fetch(oauthBase + location.replace(/\/tree$/, "/api/drevo/preview"), {
      method: "POST", headers: transferHeaders, body: readFileSync(importFile),
    });
    assert.equal(previewTransfer.status, 200,
      previewTransfer.status === 200 ? "" : await previewTransfer.text());
    const transferSummary = await previewTransfer.json();
    assert.equal(transferSummary.canImport, true);
    const transferToken = transferSummary.token;
    const importArchive = await openArchive(selectedDbPath, family, personalArchiveId);
    const importAuth = await createAuth(await userStore(importArchive.db), importArchive.db,
      process.env.PUBLIC_ORIGIN);
    let importReadReady!: () => void;
    let releaseImportRead!: () => void;
    const importReadReached = new Promise<void>((resolve) => { importReadReady = resolve; });
    const importReadGate = new Promise<void>((resolve) => { releaseImportRead = resolve; });
    let holdImportRead = false;
    const delayedImport = portableImportHttp({
      ...importArchive,
      read: async () => {
        const snapshot = await importArchive.read();
        if (holdImportRead) {
          holdImportRead = false;
          importReadReady();
          await importReadGate;
        }
        return snapshot;
      },
    }, importAuth, selectedDbPath, process.env.PUBLIC_ORIGIN);
    const portableImportServer = createServer((req, res) => {
      void delayedImport.handle(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .catch((error) => { res.destroy(error); });
    });
    await new Promise<void>((resolve) => portableImportServer.listen(0, "127.0.0.1", resolve));
    const portableImportBase = `http://127.0.0.1:${(portableImportServer.address() as { port: number }).port}`;
    try {
      await setOwnerApproved(false);
      assert.equal((await fetch(portableImportBase + "/api/drevo/preview", {
        method: "POST", headers: transferHeaders, body: readFileSync(importFile),
      })).status, 403, "an unapproved owner cannot start a portable preview");
      await setOwnerApproved(true);
      holdImportRead = true;
      const pending = fetch(portableImportBase + "/api/drevo/import", {
        method: "POST", headers: { ...transferHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ token: transferToken, confirm: true }),
      });
      let timer!: ReturnType<typeof setTimeout>;
      const progress = await Promise.race([
        importReadReached.then(() => "read"),
        pending.then(() => "responded"),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timed out"), 10_000); }),
      ]);
      clearTimeout(timer);
      assert.equal(progress, "read", "portable apply must reach the gated archive read");
      await setOwnerApproved(false);
      releaseImportRead();
      assert.equal((await pending).status, 403,
        "revoking approval after apply starts must prevent the archive write");
      assert.equal((await importArchive.db.prepare("", "SELECT data->>'status' AS status FROM workflow_stages WHERE token=?")
        .get(transferToken))?.status, "ready", "failed apply returns its stage to ready");
      assert.equal((await importArchive.read()).family.people.length, 0,
        "revoked apply must not import a person");
    } finally {
      releaseImportRead();
      await setOwnerApproved(true);
      portableImportServer.closeAllConnections();
      await new Promise<void>((resolve) => portableImportServer.close(() => resolve()));
      await delayedImport.close();
      await importArchive.close();
    }
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
    assert.equal(transferred.family.people[0].createdBy, undefined,
      "the source account ID must not become a live author in the target archive");
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [personalArchiveId]);
    await client.query(
      "INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES($1,'owner','researcher',true,'all')",
      [personalArchiveId],
    );
    const collidingAuthorToken = newSessionToken();
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
      [sessionTokenHash(collidingAuthorToken), Date.now() + 10 * 60_000],
    );
    const forgedFamily = structuredClone(transferred.family);
    forgedFamily.people[0].name = "Unauthorized edit";
    const authorEdit = await fetch(oauthBase + location.replace(/\/tree$/, "/api/family"), {
      method: "PUT",
      headers: { Cookie: `drevo_session=${collidingAuthorToken}`,
        Origin: process.env.PUBLIC_ORIGIN!, "Content-Type": "application/json",
        "If-Match": String(transferred.revision) },
      body: JSON.stringify(forgedFamily),
    });
    assert.equal(authorEdit.status, 403,
      "a researcher whose ID matched the source author cannot edit imported people");
    assert.equal((await fetch(oauthBase + location.replace(/\/tree$/, "/api/family"), {
      headers: { Cookie: sessionCookie },
    }).then((response) => response.json())).family.people[0].name, "Portable");
    const researcherHeaders = { Cookie: `drevo_session=${collidingAuthorToken}`,
      Origin: process.env.PUBLIC_ORIGIN!, "Content-Type": "application/json" };
    const discussionPath = location.replace(/\/tree$/,
      "/api/people/pg-portable-person/discussion");
    const importedDiscussion = await fetch(oauthBase + discussionPath,
      { headers: researcherHeaders }).then((response) => response.json());
    assert.equal(importedDiscussion.items[0].author, "Historian");
    assert.equal(importedDiscussion.items[0].canEdit, false);
    assert.equal((await fetch(oauthBase + `${discussionPath}/${importedDiscussion.items[0].id}`, {
      method: "PATCH", headers: researcherHeaders,
      body: JSON.stringify({ text: "Stolen comment", editedAt: null }),
    })).status, 403, "a matching source ID cannot edit imported comments");
    const documentPath = location.replace(/\/tree$/, `/api/documents/${portableDocumentId}`);
    const importedDocument = await fetch(oauthBase + `${documentPath}/annotations`,
      { headers: researcherHeaders }).then((response) => response.json());
    assert.equal(importedDocument.items[0].authorName, "Original researcher");
    assert.equal(importedDocument.items[0].canDelete, true,
      "researchers can moderate imported annotations regardless of original authorship");
    assert.equal(importedDocument.items[0].authorId, "",
      "the source author ID stays detached from local accounts");
    await client.query("UPDATE archive_memberships SET role='relative' WHERE archive_id=$1 AND user_id='owner'",
      [personalArchiveId]);
    const relativeAnnotations = await fetch(oauthBase + `${documentPath}/annotations`,
      { headers: researcherHeaders }).then((response) => response.json());
    assert.equal(relativeAnnotations.items[0].canDelete, false);
    assert.equal((await fetch(oauthBase + `${documentPath}/annotations/${portableAnnotationId}`, {
      method: "DELETE", headers: researcherHeaders,
    })).status, 403, "a relative with a matching source ID cannot delete imported annotations");
    await client.query("UPDATE archive_memberships SET role='researcher' WHERE archive_id=$1 AND user_id='owner'",
      [personalArchiveId]);
    assert.equal((await fetch(oauthBase + `${documentPath}/annotations/${portableAnnotationId}`, {
      method: "DELETE", headers: researcherHeaders,
    })).status, 200, "the researcher role grants moderation of accessible imported annotations");
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [personalArchiveId]);
    assert.equal((await client.query("SELECT uploaded_by FROM documents WHERE id=$1",
      [portableDocumentId])).rows[0]?.uploaded_by, newAccountSession.user.id,
      "the importing owner is the document uploader");
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
    const deletionDb = oauthApp.archive.db;
    const revokedDeletionToken = newSessionToken();
    const revokedDeletionHash = sessionTokenHash(revokedDeletionToken);
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'deleting-account',$2)",
      [revokedDeletionHash, Date.now() + 600_000],
    );
    const deletionAuth = await createAuth(await userStore(deletionDb), deletionDb,
      process.env.PUBLIC_ORIGIN);
    let reachedDeletionAuth!: () => void;
    let resumeDeletionAuth!: () => void;
    const deletionAuthReached = new Promise<void>((resolve) => { reachedDeletionAuth = resolve; });
    const deletionAuthGate = new Promise<void>((resolve) => { resumeDeletionAuth = resolve; });
    const guardedDeletion = accountSelfDeletionHttp(deletionDb, {
      ...deletionAuth,
      accountSession: async (req) => {
        const session = await deletionAuth.accountSession(req);
        if (session?.tokenHash === revokedDeletionHash) {
          reachedDeletionAuth();
          await deletionAuthGate;
        }
        return session;
      },
    }, true, process.env.PUBLIC_ORIGIN);
    const deletionServer = createServer((req, res) => {
      void guardedDeletion(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .catch((error) => { res.destroy(error); });
    });
    await new Promise<void>((resolve) => deletionServer.listen(0, "127.0.0.1", resolve));
    try {
      const port = (deletionServer.address() as { port: number }).port;
      const revokedDelete = fetch(`http://127.0.0.1:${port}${accountDeletionPath}`, {
        method: "DELETE",
        headers: { ...deletingHeaders, Cookie: `drevo_session=${revokedDeletionToken}`,
          Origin: process.env.PUBLIC_ORIGIN! },
        body: JSON.stringify({ name: "Delete me", leaveSharedArchives: true }),
      });
      await Promise.race([
        deletionAuthReached,
        revokedDelete.then(() => { throw new Error("Deletion completed before the session barrier"); }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Deletion did not validate its initial session")), 30_000);
          timer.unref();
        }),
      ]);
      assert.equal((await fetch(oauthBase + "/auth/logout", {
        method: "POST",
        headers: { Cookie: `drevo_session=${revokedDeletionToken}`,
          Origin: process.env.PUBLIC_ORIGIN! },
      })).status, 200, "logout commits the session revocation before deletion resumes");
      assert.equal((await client.query("SELECT 1 FROM account_sessions WHERE token_hash=$1",
        [revokedDeletionHash])).rowCount, 0);
      resumeDeletionAuth();
      const revokedResponse = await revokedDelete;
      assert.equal(revokedResponse.status, 401,
        "a session revoked after initial HTTP auth cannot delete its account");
      assert.equal((await client.query("SELECT count(*)::int AS n FROM accounts WHERE id='deleting-account'")).rows[0].n,
        1, "the revoked request leaves the account intact");
      assert.equal((await client.query("SELECT count(*)::int AS n FROM deleted_account_tombstones WHERE id='deleting-account'")).rows[0].n,
        0, "the revoked request writes no deletion tombstone");
    } finally {
      resumeDeletionAuth();
      deletionServer.closeAllConnections();
      await new Promise<void>((resolve) => deletionServer.close(() => resolve()));
    }
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
      `INSERT INTO people(archive_id,id,ordinal,data)
       SELECT 'runtime-test','former-union-peer',
         (SELECT COALESCE(max(ordinal),0)+1 FROM people WHERE archive_id='runtime-test'),
         jsonb_set(jsonb_set(data,'{id}',to_jsonb('former-union-peer'::text)),
           '{createdBy}',to_jsonb('owner'::text))
       FROM people WHERE id='person-a'`,
    );
    const formerUnion = { id: "former-union", participants: ["person-a", "former-union-peer"],
      type: "partnership", createdBy: "former-member", note: "Keep this note" };
    const unrelatedUnion = { ...formerUnion, id: "unrelated-union", createdBy: "owner" };
    for (const union of [formerUnion, unrelatedUnion])
      await client.query(
        `INSERT INTO family_unions(archive_id,id,participant_a,participant_b,data)
         VALUES('runtime-test',$1,'person-a','former-union-peer',$2::jsonb)`,
        [union.id, JSON.stringify(union)],
      );
    const formerAnnotationDocumentId = "11111111-1111-4111-8111-111111111160";
    const otherArchiveAnnotationDocumentId = "11111111-1111-4111-8111-111111111161";
    const formerAnnotationId = "22222222-2222-4222-8222-222222222260";
    const formerAnnotation = { id: formerAnnotationId, page: 1, x: 0.1, y: 0.1,
      width: 0.2, height: 0.2, text: "Keep family note", authorId: "former-member",
      authorName: "Former member", createdAt: "2026-01-01T00:00:00.000Z" };
    const ownerAnnotation = { ...formerAnnotation, id: "22222222-2222-4222-8222-222222222261",
      authorId: "owner", authorName: "Owner" };
    for (const [archiveId, documentId, annotations] of [
      ["runtime-test", formerAnnotationDocumentId, [formerAnnotation, ownerAnnotation]],
      ["other-archive", otherArchiveAnnotationDocumentId, [formerAnnotation]],
    ] as const) {
      await client.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
      await client.query(`INSERT INTO documents(archive_id,id,ordinal,title,title_search,file_name,file_size,uploaded_by,created_at,annotations)
        VALUES($1,$2,(SELECT COALESCE(max(ordinal),0)+1 FROM documents WHERE archive_id=$1),
          'Former annotations','former annotations',$3,1,'owner',now(),$4)`,
      [archiveId, documentId, `${documentId}.pdf`, JSON.stringify(annotations)]);
    }
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await client.query("UPDATE archives SET revision=revision+1 WHERE id='runtime-test'");
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
    const unionOnce = (await client.query("SELECT data FROM family_unions WHERE id='former-union'")).rows[0].data;
    await client.query("SELECT public.runtime_anonymize_deleted_account_history('former-member')");
    assert.deepEqual((await client.query("SELECT data FROM history WHERE revision=987656")).rows[0].data, once,
      "a repeated cleanup does not change the historical snapshot again");
    assert.deepEqual((await client.query("SELECT data FROM family_unions WHERE id='former-union'")).rows[0].data,
      unionOnce, "a repeated cleanup does not change the union again");
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
    assert.deepEqual((await client.query("SELECT data FROM family_unions WHERE id='former-union'")).rows[0].data,
      { ...formerUnion, createdBy: "deleted-account" },
      "former members lose live union authorship without changing union details");
    assert.deepEqual((await client.query("SELECT data FROM family_unions WHERE id='unrelated-union'")).rows[0].data,
      unrelatedUnion, "another author's union is unchanged");
    assert.deepEqual(JSON.parse((await client.query("SELECT annotations FROM documents WHERE id=$1", [formerAnnotationDocumentId])).rows[0].annotations),
      [{ ...formerAnnotation, authorId: "deleted-account", authorName: "Удалённый участник" }, ownerAnnotation],
    "account deletion anonymizes only the matching annotation without changing its text or another author");
    await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM family_unions WHERE id='former-union'")).rows[0].n,
      0, "the other archive cannot read the union through RLS");
    assert.deepEqual(JSON.parse((await client.query("SELECT annotations FROM documents WHERE id=$1", [otherArchiveAnnotationDocumentId])).rows[0].annotations),
      [{ ...formerAnnotation, authorId: "deleted-account", authorName: "Удалённый участник" }],
    "privileged cleanup also anonymizes annotations in archives the account left earlier");
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES('former-member','Returned member',$1)",
      [new Date().toISOString()]);
    await client.query("INSERT INTO account_tiers(account_id,full_access) VALUES('former-member',false)");
    await client.query(
      "INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES('runtime-test','former-member','researcher',true,'all')",
    );
    const returnedToken = newSessionToken();
    await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'former-member',$2)",
      [sessionTokenHash(returnedToken), Date.now() + 600_000]);
    const returnedHeaders = { Cookie: `drevo_session=${returnedToken}` };
    const returnedSession = await fetch(securedBase + "/api/session", { headers: returnedHeaders })
      .then((response) => response.json());
    assert.equal(returnedSession.user.role, "researcher");
    assert.equal(returnedSession.canEdit, true);
    const returnedFamily = await fetch(securedBase + "/api/family", { headers: returnedHeaders })
      .then((response) => response.json());
    assert.equal(returnedFamily.family.unions.find((union: { id: string }) =>
      union.id === "former-union")?.createdBy, "deleted-account");
    const forgedUnion = structuredClone(returnedFamily.family);
    forgedUnion.unions.find((union: { id: string }) => union.id === "former-union").note = "Taken over";
    assert.equal((await fetch(securedBase + "/api/family", {
      method: "PUT",
      headers: { ...returnedHeaders, Origin: process.env.PUBLIC_ORIGIN!,
        "Content-Type": "application/json", "If-Match": String(returnedFamily.revision) },
      body: JSON.stringify(forgedUnion),
    })).status, 403, "re-registering the same ID does not restore union edit rights");
    const annotationPath = `/api/documents/${formerAnnotationDocumentId}/annotations`;
    const returnedAnnotations = await fetch(securedBase + annotationPath, { headers: returnedHeaders });
    assert.equal(returnedAnnotations.status, 200);
    const annotationItems = (await returnedAnnotations.json()).items as Array<{ id: string; authorId: string; authorName: string; canDelete: boolean }>;
    assert.deepEqual(annotationItems.find((item) => item.id === formerAnnotationId),
      { ...formerAnnotation, authorId: "deleted-account", authorName: "Удалённый участник", canDelete: true },
    "researcher moderation leaves the predecessor's author identity anonymized");
    await client.query("UPDATE archive_memberships SET role='relative' WHERE archive_id='runtime-test' AND user_id='former-member'");
    const returnedRelativeAnnotations = await fetch(securedBase + annotationPath, { headers: returnedHeaders })
      .then(response => response.json());
    assert.equal(returnedRelativeAnnotations.items.find((item: { id: string }) => item.id === formerAnnotationId)?.canDelete, false,
      "re-registering the same ID as a relative does not regain annotation ownership");
    assert.equal((await fetch(securedBase + `${annotationPath}/${formerAnnotationId}`, {
      method: "DELETE",
      headers: { ...returnedHeaders, Origin: process.env.PUBLIC_ORIGIN! },
    })).status, 403, "a returned relative cannot delete its predecessor's shared annotation");
    await client.query("UPDATE archive_memberships SET role='researcher' WHERE archive_id='runtime-test' AND user_id='former-member'");
    assert.equal((await fetch(securedBase + `${annotationPath}/${formerAnnotationId}`, {
      method: "DELETE", headers: { ...returnedHeaders, Origin: process.env.PUBLIC_ORIGIN! },
    })).status, 200, "a researcher can moderate an anonymized annotation in an accessible document");
    await client.query("DELETE FROM documents WHERE id=$1", [formerAnnotationDocumentId]);
    await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
    await client.query("DELETE FROM documents WHERE id=$1", [otherArchiveAnnotationDocumentId]);
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await client.query("DELETE FROM archive_memberships WHERE user_id='former-member'");
    await client.query("DELETE FROM accounts WHERE id='former-member'");
    await client.query("DELETE FROM family_unions WHERE id IN ('former-union','unrelated-union')");
    await client.query("DELETE FROM people WHERE id='former-union-peer'");
    await client.query("UPDATE archives SET revision=revision+1 WHERE id='runtime-test'");
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
    assert.equal(visibleComments.items.find((item: { text: string }) => item.text === "Historical comment")?.authorPersonId, null);
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
  const placeSource = {
    id: "pg-place-claim", title: "Запись о месте", type: "архивная запись",
    author: "", institution: "", archive: "ГАСО", fond: "6", opis: "13",
    delo: "104", sheet: "7", reference: "л. 7", url: "", accessedAt: "",
    description: "", documentIds: [],
  };
  await sourceCatalogStore(app.archive.db).insert(placeSource);
  const placeBefore = await app.archive.read();
  const placeNext = structuredClone(placeBefore.family);
  const placePerson = placeNext.people[0];
  placePerson.birthPlace = "Тула";
  placePerson.deathPlace = "Казань";
  placePerson.occupation = "Столяр";
  placePerson.maidenName = "Иванова";
  placePerson.birthPlaceClaim = { value: "Тула", sources: [sourceCitation(placeSource)], confidence: "confirmed" };
  placePerson.deathPlaceClaim = { value: "Казань", sources: [sourceCitation(placeSource)], confidence: "conflicting" };
  placePerson.occupationClaim = { value: "Столяр", sources: [sourceCitation(placeSource)] };
  placePerson.maidenNameClaim = { value: "Иванова", sources: [sourceCitation(placeSource)] };
  const placeToken = newSessionToken();
  await app.archive.db.prepare("", "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'owner',?)")
    .run(sessionTokenHash(placeToken), Date.now() + 60_000);
  const placeHeaders = { ...ownerHeaders, Cookie: `drevo_session=${placeToken}` };
  const postPlaceChanges = (before: typeof placeBefore.family, next: typeof placeBefore.family,
    revision: number) => fetch(securedBase + "/api/family/changes", {
      method: "POST", headers: { ...placeHeaders, "If-Match": String(revision) },
      body: JSON.stringify({ changes: archiveChanges(before, next) }),
    });
  const placeSaved = await postPlaceChanges(placeBefore.family, placeNext, placeBefore.revision);
  assert.equal(placeSaved.status, 200, await placeSaved.text());
  const placeStored = await app.archive.read();
  assert.equal(placeStored.family.people[0].birthPlaceClaim?.sources[0].catalogId, placeSource.id);
  assert.equal(placeStored.family.people[0].deathPlaceClaim?.sources[0].catalogId, placeSource.id);
  assert.equal(placeStored.family.people[0].occupationClaim?.sources[0].catalogId, placeSource.id);
  assert.equal(placeStored.family.people[0].maidenNameClaim?.sources[0].catalogId, placeSource.id);
  assert.equal(placeStored.family.people[0].birthPlaceClaim?.confidence, "confirmed");
  assert.equal(placeStored.family.people[0].deathPlaceClaim?.confidence, "conflicting");
  assert.equal((await app.archive.db.prepare("", "SELECT data->'birthPlaceClaim'->>'value' AS place FROM people WHERE id=?")
    .get(placePerson.id))?.place, "Тула", "PostgreSQL stores the exact linked place value");
  assert.equal((await app.archive.db.prepare("", "SELECT data->'occupationClaim'->>'value' AS occupation FROM people WHERE id=?")
    .get(placePerson.id))?.occupation, "Столяр", "PostgreSQL stores the exact linked occupation value");
  assert.equal((await app.archive.db.prepare("", "SELECT data->'maidenNameClaim'->>'value' AS surname FROM people WHERE id=?")
    .get(placePerson.id))?.surname, "Иванова", "PostgreSQL stores the exact linked birth surname");
  assert.equal(await sourceCatalogStore(otherApp.archive.db).get(placeSource.id), null,
    "another PostgreSQL archive cannot read the source");
  const foreignBefore = await otherApp.archive.read();
  const foreignNext = structuredClone(foreignBefore.family);
  foreignNext.people[0].birthPlace = "Тула";
  foreignNext.people[0].birthPlaceClaim = { value: "Тула", sources: [sourceCitation(placeSource)] };
  await assert.rejects(otherApp.archive.write(foreignNext, foreignBefore.revision), /Источник отсутствует/);
  const foreignOccupation = structuredClone(foreignBefore.family);
  foreignOccupation.people[0].occupation = "Столяр";
  foreignOccupation.people[0].occupationClaim = { value: "Столяр", sources: [sourceCitation(placeSource)] };
  await assert.rejects(otherApp.archive.write(foreignOccupation, foreignBefore.revision), /Источник отсутствует/);
  const foreignSurname = structuredClone(foreignBefore.family);
  foreignSurname.people[0].maidenName = "Иванова";
  foreignSurname.people[0].maidenNameClaim = { value: "Иванова", sources: [sourceCitation(placeSource)] };
  await assert.rejects(otherApp.archive.write(foreignSurname, foreignBefore.revision), /Источник отсутствует/);
  const changedPlace = structuredClone(placeStored.family);
  changedPlace.people[0].birthPlace = "Другая Тула";
  assert.equal((await postPlaceChanges(placeStored.family, changedPlace, placeStored.revision)).status, 400);
  assert.equal((await app.archive.read()).family.people[0].birthPlace, "Тула");
  const changedOccupation = structuredClone(placeStored.family);
  changedOccupation.people[0].occupation = "Учитель";
  assert.equal((await postPlaceChanges(placeStored.family, changedOccupation, placeStored.revision)).status, 400);
  assert.equal((await app.archive.read()).family.people[0].occupation, "Столяр");
  const changedSurname = structuredClone(placeStored.family);
  changedSurname.people[0].maidenName = "Петрова";
  assert.equal((await postPlaceChanges(placeStored.family, changedSurname, placeStored.revision)).status, 400);
  assert.equal((await app.archive.read()).family.people[0].maidenName, "Иванова");
  // Keep the restore concurrency checks in their own archive: later fixtures
  // include cards by other authors, which cannot be replaced by this actor.
  const guardedArchiveId = "restore-guard-test";
  const guardedOwnerId = "restore-guard-owner";
  await client.query("SELECT set_config('drevo.archive_id',$1,false)", [guardedArchiveId]);
  await client.query(`INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version)
    VALUES($1,'Restore guard','',false,0,18)`, [guardedArchiveId]);
  await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Restore guard owner',$2)",
    [guardedOwnerId, new Date().toISOString()]);
  await client.query("INSERT INTO account_tiers(account_id,full_access) VALUES($1,true)", [guardedOwnerId]);
  await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
    VALUES($1,$2,'admin',true,'all')`, [guardedArchiveId, guardedOwnerId]);
  await client.query("INSERT INTO archive_owners(archive_id,user_id) VALUES($1,$2)",
    [guardedArchiveId, guardedOwnerId]);
  // The existing platform administrator is an approved editor here, while
  // ownership belongs to a different account to respect one-tree-per-owner.
  await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
    VALUES($1,'owner','admin',true,'all')`, [guardedArchiveId]);
  await client.query("INSERT INTO people(id,data) VALUES('person-a',$1)",
    [JSON.stringify(family.people[0])]);
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  restoreGuardApp = await startServer(0, source, true, undefined, undefined, guardedArchiveId);
  const guardedApp = restoreGuardApp;
  const guardedBase = `http://127.0.0.1:${(guardedApp.server.address() as { port: number }).port}`;
  const guardedUploads = join(dirname(guardedApp.archive.db.file), "uploads");
  // A platform grant can be revoked while a restore is copying staged media.
  // The final grant check must run inside archive.write's transaction and lock
  // the grant until commit, without holding that lock during file copying.
  const securedRestoreHeaders = { ...ownerHeaders, "X-Drevo-Restore": "1" };
  const guardedPreviewResponse = await fetch(guardedBase + "/api/restore/preview", {
    method: "POST", headers: securedRestoreHeaders, body: restoreBytes,
  });
  assert.equal(guardedPreviewResponse.status, 200, await guardedPreviewResponse.clone().text());
  const guardedPreview = await guardedPreviewResponse.json() as { token: string };
  const revisionBeforeRevocation = (await guardedApp.archive.read()).revision;
  const filesBeforeRevocation = readdirSync(guardedUploads).sort();
  const originalRestoreWrite = guardedApp.archive.write;
  let restoreAtCommit!: () => void;
  let resumeRestoreCommit!: () => void;
  const restoreCommitReady = new Promise<void>((resolve) => { restoreAtCommit = resolve; });
  const restoreCommitGate = new Promise<void>((resolve) => { resumeRestoreCommit = resolve; });
  const awaitRestoreBarrier = async (ready: Promise<void>, request: Promise<Response>) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        request.then(async (response) => {
          throw new Error(`Restore completed before the commit barrier: ${response.status} ${await response.clone().text()}`);
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Restore did not reach the commit barrier")), 30_000);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  guardedApp.archive.write = async (...args) => {
    restoreAtCommit();
    await restoreCommitGate;
    return originalRestoreWrite(...args);
  };
  try {
    const pendingApply = fetch(guardedBase + "/api/restore/apply", {
      method: "POST", headers: securedRestoreHeaders,
      body: JSON.stringify({ token: guardedPreview.token, confirm: true }),
    });
    await awaitRestoreBarrier(restoreCommitReady, pendingApply);
    await client.query("DELETE FROM platform_admins WHERE account_id='owner'");
    resumeRestoreCommit();
    const deniedApply = await pendingApply;
    assert.equal(deniedApply.status, 403, await deniedApply.text());
    assert.equal((await guardedApp.archive.read()).revision, revisionBeforeRevocation);
    assert.deepEqual(readdirSync(guardedUploads).sort(), filesBeforeRevocation,
      "revoked restore removes copies made before the commit check");
    assert.equal((await guardedApp.archive.db.prepare("", "SELECT count(*)::int AS n FROM workflow_stages WHERE kind='restore' AND token=?")
      .get(guardedPreview.token))?.n, 1, "the failed stage stays available for an authorized retry");
  } finally {
    resumeRestoreCommit();
    guardedApp.archive.write = originalRestoreWrite;
    await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
  }
  // The seed SQLite has no media or documents, so the successful lock test
  // does not copy any original files.
  const noMediaPreviewResponse = await fetch(guardedBase + "/api/restore/preview", {
    method: "POST", headers: securedRestoreHeaders, body: readFileSync(source),
  });
  assert.equal(noMediaPreviewResponse.status, 200, await noMediaPreviewResponse.clone().text());
  const noMediaPreview = await noMediaPreviewResponse.json() as {
    token: string; files: number; documents: number;
  };
  assert.equal(noMediaPreview.files, 0);
  assert.equal(noMediaPreview.documents, 0);
  let platformLockHeld!: () => void;
  let releasePlatformLock!: () => void;
  const platformLockReady = new Promise<void>((resolve) => { platformLockHeld = resolve; });
  const platformLockGate = new Promise<void>((resolve) => { releasePlatformLock = resolve; });
  guardedApp.archive.write = async (...args) => {
    const afterWrite = args[6];
    args[6] = async (db) => {
      await afterWrite?.(db);
      platformLockHeld();
      await platformLockGate;
    };
    return originalRestoreWrite(...args);
  };
  try {
    const pendingApply = fetch(guardedBase + "/api/restore/apply", {
      method: "POST", headers: securedRestoreHeaders,
      body: JSON.stringify({ token: noMediaPreview.token, confirm: true }),
    });
    await awaitRestoreBarrier(platformLockReady, pendingApply);
    const concurrentRevocation = client.query("DELETE FROM platform_admins WHERE account_id='owner'");
    try {
      assert.equal(await Promise.race([
        concurrentRevocation.then(() => "revoked"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
      ]), "waiting", "grant revocation waits for an authorized restore commit");
    } finally {
      releasePlatformLock();
    }
    const allowedApply = await pendingApply;
    assert.equal(allowedApply.status, 200, await allowedApply.text());
    await concurrentRevocation;
  } finally {
    releasePlatformLock();
    guardedApp.archive.write = originalRestoreWrite;
    await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
  }
  console.log("runtime_http_and_backup_ok");
} finally {
  await restoreGuardApp?.close();
  await otherApp?.close();
  await app?.close();
  await live?.close();
  await client.end();
  rmSync(directory, { recursive: true, force: true });
}
