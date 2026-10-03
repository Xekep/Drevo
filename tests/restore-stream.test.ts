import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { databaseBackupBytes } from "./helpers/database-backup.ts";
import { openArchive } from "../src/server/database.ts";
import { restoreStore } from "../src/server/restore.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family } from "../src/domain/types.ts";
import { sourceCatalogStore } from "../src/server/source-catalog-store.ts";
import { sourceCitation } from "../src/shared/source-catalog.ts";

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

test("restore preview awaits an asynchronous access recheck before parsing or staging data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-restore-revoked-"));
  const databasePath = join(directory, "drevo.sqlite");
  const archive = await openArchive(databasePath, family);
  const restores = restoreStore(archive, databasePath);
  try {
    const bytes = await databaseBackupBytes(archive.db);
    await assert.rejects(
      restores.previewStream(Readable.from([bytes]), admin, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error("Access revoked while uploading");
      }),
      /Access revoked/,
    );
    assert.equal(
      (
        await archive.db
          .prepare("SELECT count(*) AS n FROM workflow_stages")
          .get()
      )?.n,
      0,
    );
    assert.equal((await archive.read()).family.title, family.title);
  } finally {
    await restores.close();
    await archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore preview accepts a SQLite backup split into tiny stream chunks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-restore-stream-test-")),
    databasePath = join(directory, "drevo.sqlite"),
    archive = await openArchive(databasePath, family),
    restores = restoreStore(archive, databasePath);
  try {
    const bytes = await databaseBackupBytes(archive.db);
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
    await archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore stage survives store restart and can be applied by another instance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-restore-restart-test-")),
    databasePath = join(directory, "drevo.sqlite"),
    archive = await openArchive(databasePath, family);
  let restores = restoreStore(archive, databasePath);
  try {
    const bytes = await databaseBackupBytes(archive.db);
    await archive.write(
      { ...family, title: "Изменённый архив" },
      (await archive.read()).revision,
    );
    const preview = await restores.preview(bytes, admin);
    restores.close();
    restores = restoreStore(archive, databasePath);
    const result = await restores.apply(preview.token, admin, async () => {});
    assert.equal(result.family.title, family.title);
  } finally {
    restores.close();
    await archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore accepts an older backup without a source catalogue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-restore-legacy-sources-"));
  const databasePath = join(directory, "drevo.sqlite");
  const backupPath = join(directory, "legacy.sqlite");
  const archive = await openArchive(databasePath, family);
  const restores = restoreStore(archive, databasePath);
  try {
    writeFileSync(backupPath, await databaseBackupBytes(archive.db));
    const backup = new DatabaseSync(backupPath);
    backup.exec("DROP TABLE source_catalog");
    backup.close();
    const preview = await restores.preview(readFileSync(backupPath), admin);
    assert.equal(preview.sources, 0);
    const result = await restores.apply(preview.token, admin, async () => {});
    assert.equal(result.family.people[0].id, "person");
  } finally {
    await restores.close();
    await archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore remaps document evidence on additional family links", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-restore-link-citation-"));
  const databasePath = join(directory, "drevo.sqlite");
  const archive = await openArchive(databasePath, { ...family,
    people: [family.people[0], { ...family.people[0], id: "child", name: "Child" }],
  });
  const restores = restoreStore(archive, databasePath);
  const documentId = "d807f548-2cc4-4869-a60d-c7b05c1d7802";
  const fileName = `${documentId}.png`;
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6+fIAAAAASUVORK5CYII=", "base64");
  try {
    mkdirSync(join(directory, "uploads"), { recursive: true });
    writeFileSync(join(directory, "uploads", fileName), image);
    await archive.db.prepare(
      "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(documentId, "Evidence", "evidence", fileName, image.length, admin.id,
      "2026-01-01T00:00:00.000Z");
    const source = { id: "link-record", title: "Evidence", type: "archive",
      author: "", institution: "", archive: "", fond: "", opis: "", delo: "",
      sheet: "", reference: "page 1", url: "", accessedAt: "", description: "",
      documentIds: [documentId] };
    await sourceCatalogStore(archive.db).insert(source);
    const linked: Family = { ...(await archive.read()).family, links: [{
      id: "guardian-link", from: "person", to: "child", type: "guardian",
      sources: [{ ...sourceCitation(source), documentId, documentPage: 1 }],
    }] };
    await archive.write(linked, (await archive.read()).revision);
    const backup = await databaseBackupBytes(archive.db);
    await archive.write({ ...linked, links: [] }, (await archive.read()).revision);

    const preview = await restores.preview(backup, admin);
    const restored = await restores.apply(preview.token, admin, async () => {});
    const citation = restored.family.links?.[0].sources?.[0];
    assert.ok(citation?.documentId);
    assert.notEqual(citation.documentId, documentId);
    assert.equal(citation.documentPage, 1);
    const catalog = await sourceCatalogStore(archive.db).get(source.id);
    assert.deepEqual(catalog?.documentIds, [citation.documentId]);
    const copied = await archive.db.prepare("SELECT file_name FROM documents WHERE id=?")
      .get(citation.documentId) as { file_name: string } | undefined;
    assert.ok(copied);
    assert.deepEqual(readFileSync(join(directory, "uploads", copied.file_name)), image);
    assert.equal((await archive.read()).family.links?.[0].sources?.[0].documentId,
      citation.documentId);
  } finally {
    await restores.close();
    await archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
