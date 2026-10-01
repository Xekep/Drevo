import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";

if (!/^drevo_migration_person_patches(?:_[a-z0-9_]+)?$/.test(process.env.PGDATABASE || ""))
  throw new Error("Use a disposable drevo_migration_person_patches database");

test("media inventory separates current, historical, pending and unreferenced files across archives", async () => {
  const schema = `inventory_${randomUUID().replaceAll("-", "")}`;
  const reader = `inventory_reader_${randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client();
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema},pg_catalog`);
    await client.query(`
      CREATE TABLE archives(id text NOT NULL);
      CREATE TABLE people(archive_id text NOT NULL, data jsonb NOT NULL);
      CREATE TABLE photos(archive_id text NOT NULL, data jsonb NOT NULL);
      CREATE TABLE history(archive_id text NOT NULL, data jsonb NOT NULL);
      CREATE TABLE media_upload_grants(archive_id text NOT NULL, url text NOT NULL, expires_ms bigint NOT NULL);
      CREATE TABLE media_originals(archive_id text NOT NULL, url text NOT NULL, size_bytes bigint NOT NULL);
      CREATE TABLE documents(archive_id text NOT NULL, file_name text NOT NULL, file_size bigint NOT NULL);
    `);
    await client.query("INSERT INTO archives VALUES('tree-a'),('tree-b')");
    await client.query("INSERT INTO people VALUES('tree-a',$1),('tree-a',$2),('tree-b',$3)", [
      JSON.stringify({ photo: "/media/current.jpg" }),
      JSON.stringify({ photo: "/media/missing.png" }),
      JSON.stringify({ photo: "/media/current.jpg" }),
    ]);
    await client.query("INSERT INTO photos VALUES('tree-a',$1)", [JSON.stringify({ url: "/media/photo.png" })]);
    await client.query("INSERT INTO history VALUES('tree-a',$1)", [JSON.stringify({ people: [{ photo: "/media/old.webp" }] })]);
    await client.query("INSERT INTO media_upload_grants VALUES('tree-a','/media/pending.gif',$1)", [Date.now() + 60_000]);
    await client.query(`INSERT INTO media_originals VALUES
      ('tree-a','/media/current.jpg',10),('tree-a','/media/photo.png',20),
      ('tree-a','/media/old.webp',30),('tree-a','/media/pending.gif',40),
      ('tree-a','/media/stale.jpg',50),('tree-b','/media/current.jpg',70)`);
    await client.query("INSERT INTO documents VALUES('tree-a','document.pdf',60)");
    const results = await client.query(
      readFileSync(new URL("../../ops/postgres/media-reference-inventory.sql", import.meta.url), "utf8"),
    );
    const queryResults = (Array.isArray(results) ? results : [results]) as Array<{
      fields: Array<{ name: string }>;
      rows: Array<Record<string, unknown>>;
    }>;
    const rows = queryResults
      .find((result) => result.fields.some((field) => field.name === "known_bytes"))?.rows || [];
    const byStatus = new Map(rows.map((row) => [`${row.archive_id}:${row.status}`, [Number(row.files), Number(row.known_bytes)]]));
    assert.deepEqual(byStatus.get("tree-a:current_image"), [2, 30]);
    assert.deepEqual(byStatus.get("tree-a:history_only_image"), [1, 30]);
    assert.deepEqual(byStatus.get("tree-a:pending_image"), [1, 40]);
    assert.deepEqual(byStatus.get("tree-a:unreferenced_in_db"), [1, 50]);
    assert.deepEqual(byStatus.get("tree-a:image_missing_metadata"), [1, 0]);
    assert.deepEqual(byStatus.get("tree-a:current_document"), [1, 60]);
    assert.deepEqual(byStatus.get("tree-b:current_image"), [1, 70]);
    assert.deepEqual(byStatus.get("*all*:current_image"), [3, 100]);

    const files = await client.query(
      readFileSync(new URL("../../ops/postgres/media-filesystem-refs.sql", import.meta.url), "utf8"),
    );
    const fileResults = (Array.isArray(files) ? files : [files]) as Array<{
      fields: Array<{ name: string }>;
      rows: Array<Record<string, unknown>>;
    }>;
    const manifest = fileResults.find((result) => result.fields.length === 1 &&
      result.fields[0].name === "json_build_object")?.rows.map((row) =>
      JSON.parse(String(row.json_build_object)) as Record<string, unknown>) || [];
    assert.equal(manifest.filter((row) => row.kind === "archive").length, 2);
    assert.ok(manifest.some((row) => row.source === "document" && row.name === "document.pdf"));
    assert.ok(manifest.some((row) => row.source === "history" && row.name === "old.webp"));
    assert.ok(manifest.some((row) => row.source === "image_metadata" && row.known_bytes === 10));

    await client.query(`CREATE ROLE ${reader} NOLOGIN NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${reader}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${reader}`);
    await client.query("ALTER TABLE people ENABLE ROW LEVEL SECURITY");
    await client.query("ALTER TABLE people FORCE ROW LEVEL SECURITY");
    await client.query("CREATE POLICY archive_scope ON people USING (archive_id=current_setting('drevo.archive_id',true))");
    await client.query(`SET ROLE ${reader}`);
    await assert.rejects(client.query(
      readFileSync(new URL("../../ops/postgres/media-reference-inventory.sql", import.meta.url), "utf8"),
    ), /row-level security/i,
    "a runtime role must fail instead of receiving an incomplete inventory");
    await client.query("ROLLBACK").catch(() => {});
    await assert.rejects(client.query(
      readFileSync(new URL("../../ops/postgres/media-filesystem-refs.sql", import.meta.url), "utf8"),
    ), /row-level security/i,
    "the file manifest must also reject a partial RLS view");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.query("RESET ROLE").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.query(`DROP ROLE IF EXISTS ${reader}`).catch(() => {});
    await client.end();
  }
});
