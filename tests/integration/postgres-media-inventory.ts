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
      CREATE TABLE family_unions(archive_id text NOT NULL, data jsonb NOT NULL);
      CREATE TABLE relations(archive_id text NOT NULL, sources jsonb NOT NULL);
      CREATE TABLE photos(archive_id text NOT NULL, data jsonb NOT NULL);
      CREATE TABLE history(archive_id text NOT NULL, data jsonb NOT NULL);
      CREATE TABLE media_upload_grants(archive_id text NOT NULL, url text NOT NULL, expires_ms bigint NOT NULL);
      CREATE TABLE media_originals(archive_id text NOT NULL, url text NOT NULL, size_bytes bigint NOT NULL);
      CREATE TABLE documents(archive_id text NOT NULL, file_name text NOT NULL, file_size bigint NOT NULL);
      CREATE TABLE workflow_stages(archive_id text NOT NULL, kind text NOT NULL,
        expires_at bigint NOT NULL, data jsonb NOT NULL, directory text);
    `);
    await client.query("INSERT INTO archives VALUES('tree-a'),('tree-b')");
    await client.query("INSERT INTO people VALUES('tree-a',$1),('tree-a',$2),('tree-b',$3)", [
      JSON.stringify({ photo: "/media/current.jpg" }),
      JSON.stringify({ photo: "/media/missing.png" }),
      JSON.stringify({ photo: "/media/current.jpg" }),
    ]);
    await client.query("INSERT INTO photos VALUES('tree-a',$1)", [JSON.stringify({ url: "/media/photo.png" })]);
    await client.query("INSERT INTO people VALUES('tree-a',$1)", [JSON.stringify({
      sources: [{ url: "/media/citation.pdf#page=2" }, { url: "/media/missing-citation.pdf" }],
    })]);
    await client.query("INSERT INTO family_unions VALUES('tree-a',$1)", [JSON.stringify({
      formation: { sources: [{ url: "/media/citation.tif?page=2" }] },
    })]);
    await client.query("INSERT INTO relations VALUES('tree-a',$1)", [JSON.stringify([
      { url: "/media/link-source.jpg" },
    ])]);
    await client.query("INSERT INTO history VALUES('tree-a',$1)", [JSON.stringify({ people: [{ photo: "/media/old.webp" }] })]);
    await client.query("INSERT INTO media_upload_grants VALUES('tree-a','/media/pending.gif',$1)", [Date.now() + 60_000]);
    await client.query(`INSERT INTO media_originals VALUES
      ('tree-a','/media/current.jpg',10),('tree-a','/media/photo.png',20),
      ('tree-a','/media/old.webp',30),('tree-a','/media/pending.gif',40),
      ('tree-a','/media/stale.jpg',50),('tree-b','/media/current.jpg',70),
      ('tree-a','/media/stage-only.jpg',80),('tree-a','/media/staged.jpg',90),
      ('tree-a','/media/expired.jpg',100),('tree-b','/media/stage-only.jpg',110),
      ('tree-a','/media/citation.pdf',13),('tree-a','/media/citation.tif',14),
      ('tree-a','/media/link-source.jpg',15)`);
    await client.query("INSERT INTO documents VALUES('tree-a','document.pdf',60)");
    const restoreData = (url: string, files: unknown[] = [],
      documentPath = "/shared/uploads/old.pdf", extraPhoto?: string,
      stagedDocument = false) => JSON.stringify({
      family: { people: [{ photo: url }], photos: extraPhoto ? [{ url: extraPhoto }] : [] }, files,
      documents: [{ id: "old-document", fileName: "old.pdf", fileSize: 120 },
        ...(stagedDocument ? [{ id: "staged-document", fileName: "staged.pdf", fileSize: 20 }] : [])],
      documentFiles: [["old-document", documentPath],
        ...(stagedDocument ? [["staged-document", "/shared/staging/restore-b/uploads/staged.pdf"]] : [])],
    });
    await client.query(`INSERT INTO workflow_stages VALUES
      ('tree-a','restore',$1,$2,'/shared/staging/restore-a'),
      ('tree-a','restore',$1,$3,'/shared/staging/restore-b'),
      ('tree-a','restore',$4,$5,'/shared/staging/restore-expired'),
      ('tree-b','restore',$1,$6,'/shared/archives/tree-b/staging/restore-a')`, [
      Date.now() + 60_000,
      restoreData("/media/stage-only.jpg", [], "/shared/uploads/old.pdf", "/media/stage-unindexed.png"),
      restoreData("/media/staged.jpg", [["/media/staged.jpg", "/shared/staging/restore-b/uploads/staged.jpg"]],
        "/shared/staging/restore-b/uploads/old.pdf", undefined, true),
      Date.now() - 1,
      restoreData("/media/expired.jpg"),
      restoreData("/media/stage-only.jpg", [], "/shared/archives/tree-b/uploads/old.pdf"),
    ]);
    const summaryScript = readFileSync(new URL("../../ops/postgres/media-reference-inventory.sql", import.meta.url), "utf8");
    const manifestScript = readFileSync(new URL("../../ops/postgres/media-filesystem-refs.sql", import.meta.url), "utf8");
    const results = await client.query(summaryScript);
    const queryResults = (Array.isArray(results) ? results : [results]) as Array<{
      fields: Array<{ name: string }>;
      rows: Array<Record<string, unknown>>;
    }>;
    const rows = queryResults
      .find((result) => result.fields.some((field) => field.name === "known_bytes"))?.rows || [];
    const byStatus = new Map(rows.map((row) => [`${row.archive_id}:${row.status}`, [Number(row.files), Number(row.known_bytes)]]));
    assert.deepEqual(byStatus.get("tree-a:current_image"), [2, 30]);
    assert.deepEqual(byStatus.get("tree-a:current_citation"), [3, 42]);
    assert.deepEqual(byStatus.get("tree-a:citation_missing_metadata"), [1, 0]);
    assert.deepEqual(byStatus.get("tree-a:history_only_image"), [1, 30]);
    assert.deepEqual(byStatus.get("tree-a:pending_image"), [1, 40]);
    assert.deepEqual(byStatus.get("tree-a:unreferenced_in_db"), [3, 240]);
    assert.deepEqual(byStatus.get("tree-a:restore_stage_image"), [1, 80]);
    assert.deepEqual(byStatus.get("tree-b:restore_stage_image"), [1, 110]);
    assert.deepEqual(byStatus.get("tree-a:restore_stage_document"), [1, 120]);
    assert.deepEqual(byStatus.get("tree-a:restore_stage_image_missing_metadata"), [1, 0]);
    assert.deepEqual(byStatus.get("tree-a:image_missing_metadata"), [1, 0]);
    assert.deepEqual(byStatus.get("tree-a:current_document"), [1, 60]);
    assert.deepEqual(byStatus.get("tree-b:current_image"), [1, 70]);
    assert.deepEqual(byStatus.get("*all*:current_image"), [3, 100]);

    const files = await client.query(manifestScript);
    const fileResults = (Array.isArray(files) ? files : [files]) as Array<{
      fields: Array<{ name: string }>;
      rows: Array<Record<string, unknown>>;
    }>;
    const manifest = fileResults.find((result) => result.fields.length === 1 &&
      result.fields[0].name === "json_build_object")?.rows.map((row) =>
      JSON.parse(String(row.json_build_object)) as Record<string, unknown>) || [];
    assert.equal(manifest.filter((row) => row.kind === "archive").length, 2);
    assert.ok(manifest.some((row) => row.source === "document" && row.name === "document.pdf"));
    for (const name of ["citation.pdf", "citation.tif", "link-source.jpg", "missing-citation.pdf"])
      assert.ok(manifest.some((row) => row.source === "citation" && row.name === name),
        `direct citation retains ${name} even without original metadata`);
    assert.ok(manifest.some((row) => row.source === "history" && row.name === "old.webp"));
    assert.ok(manifest.some((row) => row.source === "image_metadata" && row.known_bytes === 10));
    assert.ok(manifest.some((row) => row.source === "restore_stage_image" &&
      row.archive_id === "tree-a" && row.name === "stage-only.jpg"));
    assert.ok(manifest.some((row) => row.source === "restore_stage_image" &&
      row.archive_id === "tree-a" && row.name === "stage-unindexed.png"));
    assert.ok(manifest.some((row) => row.source === "restore_stage_image" &&
      row.archive_id === "tree-b" && row.name === "stage-only.jpg"));
    assert.ok(!manifest.some((row) => row.source === "restore_stage_image" &&
      ["staged.jpg", "expired.jpg"].includes(String(row.name))));
    assert.ok(manifest.some((row) => row.source === "restore_stage_document" &&
      row.name === "old.pdf" && row.known_bytes === 120));
    assert.ok(!manifest.some((row) => row.source === "restore_stage_document" &&
      row.name === "staged.pdf"));

    await client.query("INSERT INTO media_originals VALUES('tree-a','/media/race.jpg',13)");
    const snapshotReader = new pg.Client();
    await snapshotReader.connect();
    try {
      await snapshotReader.query(`SET search_path TO ${schema},pg_catalog`);
      await snapshotReader.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await snapshotReader.query("SELECT count(*) FROM workflow_stages");
      await client.query("INSERT INTO workflow_stages VALUES('tree-a','restore',$1,$2,'/shared/staging/restore-race')", [
        Date.now() + 60_000, restoreData("/media/race.jpg"),
      ]);
      const statement = summaryScript.slice(summaryScript.indexOf("\nWITH ") + 1,
        summaryScript.lastIndexOf("\nCOMMIT;")).trim();
      const oldRows = (await snapshotReader.query(statement)).rows;
      assert.equal(oldRows.find((row) => row.archive_id === "tree-a" &&
        row.status === "unreferenced_in_db")?.known_bytes, "253",
        "a repeatable-read report cannot see a stage created after its snapshot");
      await snapshotReader.query("COMMIT");
      const freshResults = await client.query(summaryScript);
      const freshQueryResults = (Array.isArray(freshResults) ? freshResults : [freshResults]) as Array<{
        fields: Array<{ name: string }>;
        rows: Array<Record<string, unknown>>;
      }>;
      const freshRows = freshQueryResults
        .find((result) => result.fields.some((field) => field.name === "known_bytes"))?.rows || [];
      assert.equal(freshRows.find((row) => row.archive_id === "tree-a" &&
        row.status === "restore_stage_image")?.known_bytes, "93",
        "a new inventory sees the concurrent stage and retains its current-original fallback");
    } finally {
      await snapshotReader.query("ROLLBACK").catch(() => {});
      await snapshotReader.end();
    }

    await client.query(`CREATE ROLE ${reader} NOLOGIN NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${reader}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${reader}`);
    await client.query("ALTER TABLE people ENABLE ROW LEVEL SECURITY");
    await client.query("ALTER TABLE people FORCE ROW LEVEL SECURITY");
    await client.query("CREATE POLICY archive_scope ON people USING (archive_id=current_setting('drevo.archive_id',true))");
    await client.query(`SET ROLE ${reader}`);
    await assert.rejects(client.query(summaryScript), /row-level security/i,
    "a runtime role must fail instead of receiving an incomplete inventory");
    await client.query("ROLLBACK").catch(() => {});
    await assert.rejects(client.query(manifestScript), /row-level security/i,
    "the file manifest must also reject a partial RLS view");
    await client.query("ROLLBACK").catch(() => {});
    await client.query(`RESET ROLE`);
    await client.query("ALTER TABLE people DISABLE ROW LEVEL SECURITY");
    await client.query("ALTER TABLE workflow_stages ENABLE ROW LEVEL SECURITY");
    await client.query("ALTER TABLE workflow_stages FORCE ROW LEVEL SECURITY");
    await client.query("CREATE POLICY archive_scope ON workflow_stages USING (archive_id=current_setting('drevo.archive_id',true))");
    await client.query(`SET ROLE ${reader}`);
    await assert.rejects(client.query(summaryScript), /row-level security/i,
    "the summary must reject a partial view of restore stages");
    await client.query("ROLLBACK").catch(() => {});
    await assert.rejects(client.query(manifestScript), /row-level security/i,
    "the manifest must reject a partial view of restore stages");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.query("RESET ROLE").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.query(`DROP ROLE IF EXISTS ${reader}`).catch(() => {});
    await client.end();
  }
});
