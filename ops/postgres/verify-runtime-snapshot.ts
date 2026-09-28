import assert from "node:assert/strict";
import { resolve, join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { openArchive, readArchive } from "../../src/server/database.ts";
import { storeDatabase } from "../../src/server/store-database.ts";
import { writeDatabaseBackup } from "../../src/server/backup.ts";
import { startServer } from "../../src/server/index.ts";

const [snapshotPath, archiveId] = process.argv.slice(2);
if (
  !snapshotPath ||
  !archiveId ||
  !/^drevo_(migration|preflight)_[a-z0-9_]+$/.test(process.env.PGDATABASE || "")
)
  throw new Error(
    "Use a disposable migration/preflight database and a consistent SQLite snapshot",
  );
const file = resolve(snapshotPath);
if (/[/\\]drevo\.sqlite$/.test(file))
  throw new Error("Working SQLite is forbidden");
const sqlite = storeDatabase(new DatabaseSync(file, { readOnly: true }));
const expected = await readArchive(sqlite);
process.env.DATABASE_BACKEND = "postgres";
process.env.ARCHIVE_ID = archiveId;
delete process.env.PUBLIC_ORIGIN;
const live = await openArchive(file, expected.family);
try {
  assert.deepEqual(
    await live.read(),
    expected,
    "Runtime hydration differs from SQLite",
  );
  for (const [engine, read] of [
    ["sqlite", () => readArchive(sqlite)],
    ["postgres", () => live.read()],
  ] as const) {
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const began = performance.now();
      await read();
      times.push(performance.now() - began);
    }
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        engine,
        operation: "full_archive_read",
        samples: times.length,
        p50Ms: times[14],
        p95Ms: times[28],
      }),
    );
  }
  const portable = join(dirname(file), "runtime-portable.sqlite");
  await writeDatabaseBackup(live.db, portable);
  const backup = storeDatabase(new DatabaseSync(portable, { readOnly: true }));
  try {
    assert.deepEqual(await readArchive(backup), expected);
    const normalize = (value: unknown): unknown => {
      if (typeof value === "string") {
        try {
          return normalize(JSON.parse(value));
        } catch {
          return value;
        }
      }
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, normalize(entry)]),
        );
      return value;
    };
    const tables = await sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    for (const row of tables) {
      const table = String(row.name);
      assert.match(table, /^[a-z_]+$/);
      const original = (await sqlite.prepare(`SELECT * FROM ${table}`).all())
        .map((row) => JSON.stringify(normalize(row)))
        .sort();
      const copied = (await backup.prepare(`SELECT * FROM ${table}`).all())
        .map((row) => JSON.stringify(normalize(row)))
        .sort();
      assert.deepEqual(copied, original, `Portable backup differs in ${table}`);
    }
    console.log(
      JSON.stringify({ portableBackupTablesVerified: tables.length }),
    );
  } finally {
    await backup.close();
  }
} finally {
  await live.close();
  await sqlite.close();
}
const app = await startServer(0, file, true);
try {
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  for (const path of [
    "/api/health",
    "/api/family",
    "/api/documents",
    "/api/users",
    "/api/audit",
    "/api/shares",
    "/api/backups",
    "/api/admin/ai",
    "/api/admin/research-resources",
    "/api/mcp/tokens",
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    await response.arrayBuffer();
  }
  assert.deepEqual(await app.archive.read(), expected);
  console.log(
    JSON.stringify({
      verified: true,
      revision: expected.revision,
      people: expected.family.people.length,
      photos: expected.family.photos?.length || 0,
    }),
  );
} finally {
  await app.close();
}
