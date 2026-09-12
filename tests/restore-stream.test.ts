import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { databaseBackupBytes } from "./helpers/database-backup.ts";
import { openArchive } from "../src/server/database.ts";
import { restoreStore } from "../src/server/restore.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family } from "../src/domain/types.ts";

const family: Family = {
  title: "Потоковый restore",
  description: "",
  demo: false,
  people: [
    {
      id: "person",
      surname: "Тестов",
      name: "Поток",
      patronymic: "",
      sex: "u",
      birth: "",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      generation: 1,
      column: 0,
    },
  ],
};

const admin: ArchiveUser = {
  id: "admin",
  name: "Администратор",
  role: "admin",
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("restore preview accepts a SQLite backup split into tiny stream chunks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-restore-stream-test-")),
    databasePath = join(directory, "drevo.sqlite"),
    archive = openArchive(databasePath, family),
    restores = restoreStore(archive, databasePath);
  try {
    const bytes = databaseBackupBytes(archive.db);
    async function* tinyChunks() {
      for (let offset = 0; offset < bytes.length; offset += 7)
        yield bytes.subarray(offset, offset + 7);
    }
    const preview = await restores.previewStream(
      Readable.from(tinyChunks()),
      admin,
    );
    assert.equal(preview.title, family.title);
    assert.equal(preview.people, 1);
    assert.equal(preview.currentPeople, 1);
    assert.equal(typeof preview.token, "string");
  } finally {
    restores.close();
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore stage survives store restart and can be applied by another instance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-restore-restart-test-")),
    databasePath = join(directory, "drevo.sqlite"),
    archive = openArchive(databasePath, family);
  let restores = restoreStore(archive, databasePath);
  try {
    const bytes = databaseBackupBytes(archive.db);
    archive.write(
      { ...family, title: "Изменённый архив" },
      archive.read().revision,
    );
    const preview = await restores.preview(bytes, admin);
    restores.close();
    restores = restoreStore(archive, databasePath);
    const result = await restores.apply(preview.token, admin);
    assert.equal(result.family.title, family.title);
  } finally {
    restores.close();
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
