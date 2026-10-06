import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  storeDatabase,
  postgresBindings,
  configuredDatabaseBackend,
  postgresPoolSize,
} from "../src/server/store-database.ts";

test("PostgreSQL pools default to a bounded two-process connection budget", () => {
  assert.equal(postgresPoolSize(""), 3);
  assert.equal(2 * 4 * postgresPoolSize(""), 24);
  assert.equal(postgresPoolSize("3"), 3);
  for (const value of ["1", "2", "0", "11", "2.5", "2junk", "-2"])
    assert.throws(() => postgresPoolSize(value), /DREVO_PG_POOL_SIZE/);
});

test("cutover marker refuses accidental fallback to stale SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-cutover-"));
  const saved = process.env.DATABASE_BACKEND;
  try {
    delete process.env.DATABASE_BACKEND;
    assert.equal(
      configuredDatabaseBackend(join(directory, "archive.sqlite")),
      "sqlite",
    );
    writeFileSync(join(directory, "postgres.active"), "legacy-primary");
    assert.throws(
      () => configuredDatabaseBackend(join(directory, "archive.sqlite")),
      /устаревшей SQLite/,
    );
    process.env.DATABASE_BACKEND = "postgres";
    assert.equal(
      configuredDatabaseBackend(join(directory, "archive.sqlite")),
      "postgres",
    );
    process.env.DATABASE_BACKEND = "postgre";
    assert.throws(
      () => configuredDatabaseBackend(join(directory, "archive.sqlite")),
      /Неизвестный/,
    );
  } finally {
    if (saved === undefined) delete process.env.DATABASE_BACKEND;
    else process.env.DATABASE_BACKEND = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite transaction ownership spans awaits and blocks unrelated reads", async () => {
  const db = storeDatabase(new DatabaseSync(":memory:"));
  await db.exec(
    "CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0)",
  );
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const write = db.transaction(async () => {
    await db.prepare("UPDATE counter SET value=1").run();
    began();
    await gate;
  });
  await started;
  let readFinished = false;
  const read = db
    .prepare("SELECT value FROM counter")
    .get()
    .then((row) => {
      readFinished = true;
      return row;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(readFinished, false);
  release();
  await write;
  assert.equal((await read)?.value, 1);
  await db.close();
});

test("detached asynchronous work cannot reuse a completed transaction context", async () => {
  const db = storeDatabase(new DatabaseSync(":memory:"));
  await db.exec(
    "CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0)",
  );
  let detached!: Promise<void>;
  await db.transaction(async () => {
    detached = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        assert
          .rejects(
            db.prepare("UPDATE counter SET value=99").run(),
            /контекст|Контекст/,
          )
          .then(resolve, reject);
      });
    });
  });
  await detached;
  assert.equal((await db.prepare("SELECT value FROM counter").get())?.value, 0);
  await db.close();
});

test("PostgreSQL binding conversion preserves quoted question marks and escaped quotes", () => {
  assert.equal(
    postgresBindings(
      "SELECT '?', '''?', \"?\" FROM people WHERE id=? AND data->>'name'=?",
    ),
    "SELECT '?', '''?', \"?\" FROM people WHERE id=$1 AND data->>'name'=$2",
  );
});
