import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupProcess } from "../../src/server/backup-process.ts";
import { platformBackupSnapshot } from "../../src/server/platform-backup-snapshot.ts";

// This entry point creates/drops ONLY disposable CI databases. Never run in production.
assert.equal(process.env.PGDATABASE, "drevo_migration_person_patches");
assert.ok(["127.0.0.1", "localhost"].includes(process.env.PGHOST || ""));
const suffix = randomUUID().replaceAll("-", ""), sourceName = "drevo_backup_smoke_" + suffix;
const restoredName = "drevo_backup_restore_" + suffix, operator = "backup_smoke_" + suffix;
const password = randomUUID().replaceAll("-", "");
const previous = { ...process.env }, signal = new AbortController().signal;
const admin = new pg.Client(); await admin.connect();
const root = await mkdtemp(join(tmpdir(), "platform-native-smoke-"));
let source: pg.Client | undefined, recovered: pg.Client | undefined;
try {
  await admin.query('CREATE DATABASE "' + sourceName + '"');
  await admin.query('CREATE DATABASE "' + restoredName + '"');
  await admin.query('CREATE ROLE "' + operator + '" LOGIN NOSUPERUSER BYPASSRLS CONNECTION LIMIT 2 PASSWORD \'' + password + "'");
  await admin.query('GRANT pg_read_all_data TO "' + operator + '"');
  await admin.query('ALTER ROLE "' + operator + '" SET default_transaction_read_only=on');
  source = new pg.Client({ database: sourceName }); await source.connect();
  await source.query(`
    CREATE TABLE archives(id text PRIMARY KEY);
    CREATE TABLE accounts(id text PRIMARY KEY,name text);
    CREATE TABLE platform_test_config(id int,value text);
    CREATE TABLE people(archive_id text,data jsonb);
    CREATE TABLE photos(archive_id text,data jsonb);
    CREATE TABLE history(archive_id text,data jsonb);
    CREATE TABLE family_unions(archive_id text,data jsonb);
    CREATE TABLE relations(archive_id text,sources jsonb);
    CREATE TABLE workflow_stages(archive_id text,kind text,expires_at bigint,data jsonb,directory text);
    CREATE TABLE documents(archive_id text,file_name text,file_size bigint);
    CREATE TABLE media_upload_grants(archive_id text,url text,expires_ms bigint);
    CREATE TABLE media_originals(archive_id text,url text,size_bytes bigint);
    CREATE TABLE person_comments(archive_id text,attachments jsonb);
    CREATE TABLE ai_chat_messages(archive_id text,data jsonb);
    CREATE TABLE ai_settings(archive_id text,api_key_ciphertext text);
    CREATE TABLE platform_ai_cleanup_keys(version int,fingerprint text);
    INSERT INTO archives VALUES('primary-smoke'),('second-smoke');
    INSERT INTO accounts VALUES('one','Первый'),('two','Второй');
    INSERT INTO platform_test_config VALUES(1,'global configuration');
    INSERT INTO people VALUES('primary-smoke','{"name":"Первый"}'),('second-smoke','{"name":"Второй"}');
    ALTER TABLE people ENABLE ROW LEVEL SECURITY; ALTER TABLE people FORCE ROW LEVEL SECURITY;
    CREATE POLICY selected_tree ON people USING(archive_id=current_setting('drevo.archive_id',true));
    INSERT INTO documents VALUES('primary-smoke','main.pdf',4),('second-smoke','other.pdf',5);
  `);
  await mkdir(join(root, "uploads")); await writeFile(join(root, "uploads/main.pdf"), "main");
  await mkdir(join(root, "archives/second-smoke/uploads"), { recursive: true });
  await writeFile(join(root, "archives/second-smoke/uploads/other.pdf"), "other");
  const stage = join(root, "snapshot"); await mkdir(stage);
  Object.assign(process.env, { DATABASE_BACKEND: "postgres", PGDATABASE: sourceName, PGUSER: operator,
    PGPASSWORD: password, PLATFORM_BACKUP_PGUSER: operator, PLATFORM_BACKUP_PGPASSWORD: password });
  await platformBackupSnapshot(join(root, "drevo.sqlite"), "primary-smoke", stage, signal);
  const manifest = JSON.parse(await readFile(join(stage, "platform-manifest.json"), "utf8"));
  assert.deepEqual(manifest.archiveIds, ["primary-smoke", "second-smoke"]);
  assert.equal(await readFile(join(stage, "shared/archives/second-smoke/uploads/other.pdf"), "utf8"), "other");
  process.env.PGUSER = previous.PGUSER; process.env.PGPASSWORD = previous.PGPASSWORD;
  await backupProcess("pg_restore", ["--exit-on-error", "--no-owner", "--no-acl",
    "--dbname=" + restoredName, join(stage, "platform.pgdump")], signal);
  recovered = new pg.Client({ database: restoredName }); await recovered.connect();
  assert.equal((await recovered.query("SELECT count(*) AS n FROM people")).rows[0].n, "2");
  assert.equal((await recovered.query("SELECT count(*) AS n FROM accounts")).rows[0].n, "2");
  assert.equal((await recovered.query("SELECT value FROM platform_test_config")).rows[0].value, "global configuration");
  assert.equal((await recovered.query("SELECT count(*) AS n FROM documents")).rows[0].n, "2");
  // A scoped runtime role must not be accepted as a global operator.
  await admin.query('ALTER ROLE "' + operator + '" NOBYPASSRLS');
  process.env.PGUSER = operator; process.env.PGPASSWORD = password;
  await assert.rejects(platformBackupSnapshot(join(root, "drevo.sqlite"), "primary-smoke", join(root, "denied"), signal),
    /Runtime-роль/);
  console.log("platform_native_multiple_archives_restore_and_role_guard_ok");
} finally {
  await source?.end(); await recovered?.end();
  await admin.query('DROP DATABASE IF EXISTS "' + restoredName + '" WITH (FORCE)');
  await admin.query('DROP DATABASE IF EXISTS "' + sourceName + '" WITH (FORCE)');
  await admin.query('DROP ROLE IF EXISTS "' + operator + '"');
  await admin.end(); await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}
