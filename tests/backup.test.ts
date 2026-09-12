import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Family } from "../src/domain/types.ts";
import { writeDatabaseBackup } from "../src/server/backup.ts";
import { openArchive } from "../src/server/database.ts";

const seed: Family = {
  title: "Backup test",
  description: "",
  demo: false,
  people: [],
  links: [],
  photos: [],
};

test("writeDatabaseBackup creates a standalone private SQLite file", () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-backup-test-"));
  const source = join(directory, "source.sqlite");
  const destination = join(directory, "backup.sqlite");
  const store = openArchive(source, seed);
  try {
    writeDatabaseBackup(store.db, destination);

    if (process.platform !== "win32")
      assert.equal(statSync(destination).mode & 0o777, 0o600);
    const backup = new DatabaseSync(destination);
    try {
      const row = backup
        .prepare("SELECT title, revision FROM archive WHERE id = 1")
        .get() as { title: string; revision: number };
      assert.equal(row.title, "Backup test");
      assert.equal(row.revision, 1);
      assert.equal(
        backup.prepare("PRAGMA integrity_check").get()?.integrity_check,
        "ok",
      );
    } finally {
      backup.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("writeDatabaseBackup does not delete an existing destination on failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-backup-existing-"));
  const source = join(directory, "source.sqlite");
  const destination = join(directory, "already-there.sqlite");
  const store = openArchive(source, seed);
  try {
    writeFileSync(destination, "sentinel", { mode: 0o600 });
    assert.throws(() => writeDatabaseBackup(store.db, destination));
    assert.equal(readFileSync(destination, "utf8"), "sentinel");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
