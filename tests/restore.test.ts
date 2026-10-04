import { storeDatabase } from "../src/server/store-database.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { startServer } from "../src/server/index.ts";
import { openArchive, readArchive } from "../src/server/database.ts";
import { restoreStore } from "../src/server/restore.ts";
import { fullBackup } from "../src/server/full-backup.ts";
import { sourceComments } from "../src/server/restore-comments.ts";
import { databaseBackupBytes } from "./helpers/database-backup.ts";
import { userStore } from "../src/server/users.ts";
import { settingsStore } from "../src/server/settings.ts";
import type { Family, Person } from "../src/domain/types.ts";
const p: Person = {
  id: "test-person",
  name: "Анна",
  surname: "Тестова",
  patronymic: "",
  sex: "f",
  birth: "1950",
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  column: 0,
  generation: 1,
};
const family: Family = {
  title: "Импорт",
  description: "",
  demo: false,
  people: [p],
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6+fIAAAAASUVORK5CYII=",
  "base64",
);

test("full backup restores a 100 MiB citation-only PDF, remaps shared media and retains page suffixes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-restore-citations-"));
  const source = await startServer(
    0,
    join(directory, "source", "drevo.sqlite"),
    true,
  );
  let target: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const pdf = Buffer.alloc(100 * 1024 * 1024, 32);
    pdf.write("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF");
    for (const [name, bytes] of [
      ["citation.png", png],
      ["shared.png", png],
      ["citation.pdf", pdf],
    ] as const)
      writeFileSync(join(directory, "source", "uploads", name), bytes);
    const cited: Family = {
      ...family,
      people: [
        {
          ...p,
          photo: "/media/shared.png",
          sources: [
            {
              title: "Скан",
              type: "archive",
              reference: "",
              url: "/media/citation.png#page=2",
            },
          ],
          birthDateClaim: {
            value: p.birth,
            sources: [
              {
                title: "Портрет",
                type: "photo",
                reference: "",
                url: "/media/shared.png?scan=1#page=3",
              },
            ],
          },
        },
        { ...p, id: "second-person", name: "Борис" },
      ],
      unions: [
        {
          id: "union",
          type: "marriage",
          participants: [p.id, "second-person"],
          sources: [
            {
              title: "PDF",
              type: "archive",
              reference: "",
              url: "/media/citation.pdf#page=4",
            },
          ],
        },
      ],
      links: [
        {
          id: "care",
          type: "presumed_parent",
          from: p.id,
          to: "second-person",
          sources: [
            {
              title: "Связь",
              type: "archive",
              reference: "",
              url: "/media/citation.png?scan=2",
            },
          ],
        },
      ],
    };
    await source.archive.write(cited, (await source.archive.read()).revision);
    const sourceBase = `http://127.0.0.1:${(source.server.address() as { port: number }).port}`;
    const full = Buffer.from(
      await (await fetch(sourceBase + "/api/backup/full")).arrayBuffer(),
    );
    target = await startServer(
      0,
      join(directory, "target", "drevo.sqlite"),
      true,
    );
    const targetBase = `http://127.0.0.1:${(target.server.address() as { port: number }).port}`;
    const request = (part: string, body: Buffer | object) =>
      fetch(targetBase + "/api/restore/" + part, {
        method: "POST",
        headers: { "X-Drevo-Restore": "1" },
        body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
      });
    const incomplete = await request(
      "preview",
      await databaseBackupBytes(source.archive.db),
    );
    assert.equal(incomplete.status, 200, await incomplete.clone().text());
    assert.equal(
      (await incomplete.json()).missing,
      3,
      "citation originals are included in missing",
    );
    const collisionPath = join(directory, "target", "uploads", "citation.pdf");
    const unrelatedPdf = Buffer.from(
      "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% unrelated target file\n%%EOF",
    );
    writeFileSync(collisionPath, unrelatedPdf);
    const incompleteTar = tar(
      "drevo.sqlite",
      await databaseBackupBytes(source.archive.db),
    );
    const collision = await request("preview", incompleteTar);
    assert.equal(collision.status, 400, await collision.clone().text());
    assert.match((await collision.json()).error, /одноимённый файл/i);
    assert.deepEqual(readFileSync(collisionPath), unrelatedPdf);
    rmSync(collisionPath);
    const previewResponse = await request("preview", full);
    assert.equal(
      previewResponse.status,
      200,
      await previewResponse.clone().text(),
    );
    const preview = await previewResponse.json();
    assert.equal(preview.files, 3);
    assert.equal(preview.missing, 0);
    const applied = await request("apply", {
      token: preview.token,
      confirm: true,
    });
    assert.equal(applied.status, 200, await applied.clone().text());
    const restored = (await target.archive.read()).family;
    const person = restored.people[0];
    assert.notEqual(person.photo, "/media/shared.png");
    assert.equal(
      person.birthDateClaim!.sources[0].url,
      person.photo + "?scan=1#page=3",
    );
    const sourceUrl = person.sources[0].url!;
    assert.match(sourceUrl, /\.png#page=2$/);
    assert.notEqual(sourceUrl, cited.people[0].sources[0].url);
    assert.equal(
      restored.links![0].sources![0].url,
      sourceUrl.replace("#page=2", "?scan=2"),
    );
    assert.match(restored.unions![0].sources![0].url!, /\.pdf#page=4$/);
    for (const [url, expected] of [
      [sourceUrl, png],
      [person.photo!, png],
      [restored.unions![0].sources![0].url!, pdf],
    ] as const) {
      const response = await fetch(targetBase + url);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    }
    assert.equal(readdirSync(join(directory, "target", "uploads")).length, 3);
  } finally {
    await target?.close();
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
function tar(name: string, content: Buffer, type = "0", size = content.length) {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write("0000600\0", 100);
  header.write(size.toString(8).padStart(11, "0") + "\0", 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write(
    header
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
  );
  return gzipSync(
    Buffer.concat([
      header,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
}
test("restore preview counts cascaded current comments and skipped backup comments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-restore-comments-"));
  const removed = { ...p, id: "removed-person", name: "Удаляемый" };
  const current = await openArchive(join(dir, "current.sqlite"), {
    ...family,
    people: [p, removed],
  });
  const source = await openArchive(join(dir, "source.sqlite"), family);
  const restores = restoreStore(current, join(dir, "current.sqlite"));
  const admin = {
    id: "admin",
    name: "Администратор",
    role: "admin" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  try {
    for (const [personId, text] of [
      [p.id, "retained"],
      [removed.id, "lost-1"],
      [removed.id, "lost-2"],
    ])
      await current.db
        .prepare(
          "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,'admin',1000,?)",
        )
        .run(personId, text);
    for (const text of ["source-1", "source-2", "source-3"])
      await source.db
        .prepare(
          "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,'admin',1000,?)",
        )
        .run(p.id, text);
    const preview = await restores.preview(
      await databaseBackupBytes(source.db),
      admin,
    );
    assert.equal(preview.currentCommentsLost, 2);
    assert.equal(preview.backupCommentsSkipped, 3);
    await current.write(family, (await current.read()).revision);
    assert.deepEqual(
      (
        await current.db
          .prepare("SELECT text FROM person_comments ORDER BY id")
          .all()
      ).map((row) => row.text),
      ["retained"],
    );

    await source.db.exec("DROP TABLE person_comments");
    const legacy = await restores.preview(
      await databaseBackupBytes(source.db),
      admin,
    );
    assert.equal(legacy.currentCommentsLost, 0);
    assert.equal(legacy.backupCommentsSkipped, 0);
  } finally {
    await restores.close();
    await source.close();
    await current.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("family import previews a full backup containing private discussion and AI files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-import-private-"));
  const databasePath = join(dir, "drevo.sqlite");
  const archive = await openArchive(databasePath, family);
  const restores = restoreStore(archive, databasePath);
  const id = "a5ac420a-5ed9-44ee-a307-8550f6b64708";
  const admin = {
    id: "admin",
    name: "Администратор",
    role: "admin" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  try {
    const backup = await databaseBackupBytes(archive.db);
    const entry = (name: string, data = Buffer.alloc(0), type = "0") =>
      gunzipSync(tar(name, data, type)).subarray(0, -1024);
    const privateBytes = Buffer.from("private attachment");
    const full = gzipSync(
      Buffer.concat([
        entry("drevo.sqlite", backup),
        entry("uploads/", Buffer.alloc(0), "5"),
        entry("uploads/discussion-files/", Buffer.alloc(0), "5"),
        entry(`uploads/discussion-files/${id}`, privateBytes),
        entry(`uploads/discussion-files/${id}.webp`, privateBytes),
        entry("uploads/ai-chat-files/", Buffer.alloc(0), "5"),
        entry(`uploads/ai-chat-files/${id}/`, Buffer.alloc(0), "5"),
        entry(`uploads/ai-chat-files/${id}/${id}`, privateBytes),
        Buffer.alloc(1024),
      ]),
    );
    const preview = await restores.preview(full, admin);
    assert.equal(preview.people, 1);
    const stage = await archive.db
      .prepare("SELECT directory FROM workflow_stages WHERE token=?")
      .get(preview.token);
    assert.ok(stage?.directory);
    assert.equal(
      readdirSync(join(String(stage.directory), "uploads")).length,
      0,
      "family import must not stage private attachments that it cannot restore",
    );
    for (const forbidden of [
      `uploads/discussion-files/${id}/../../escape`,
      `uploads/ai-chat-files/${id}/../../escape`,
    ]) {
      const malformed = gzipSync(
        Buffer.concat([
          entry("drevo.sqlite", backup),
          entry(forbidden, privateBytes),
          Buffer.alloc(1024),
        ]),
      );
      await assert.rejects(
        restores.preview(malformed, admin),
        /Недопустимый путь/,
      );
    }
  } finally {
    await restores.close();
    await archive.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opt-in full restore imports discussions with fresh file and author IDs; ordinary restore keeps existing comments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-restore-discussions-"));
  const source = await openArchive(join(dir, "source.sqlite"), family);
  const target = await openArchive(join(dir, "target.sqlite"), family);
  const restores = restoreStore(target, join(dir, "target.sqlite"));
  const admin = { id: "admin", name: "Администратор", role: "admin" as const,
    createdAt: "2026-01-01T00:00:00.000Z" };
  const originalId = "a5ac420a-5ed9-44ee-a307-8550f6b64708";
  const attachmentBytes = Buffer.from("Source discussion attachment\n");
  const fileOnlyId = "b6bd531b-6fea-45ff-b418-9661f7c75819";
  const fileOnlyBytes = await sharp({
    create: { width: 2, height: 2, channels: 4, background: "#4477aa" },
  }).png().toBuffer();
  const entry = (name: string, data: Buffer) =>
    gunzipSync(tar(name, data)).subarray(0, -1024);
  try {
    await source.db.prepare(`INSERT INTO person_comments
      (person_id,author_id,author_name,created_ms,text,updated_ms,attachments)
      VALUES(?,?,?,?,?,?,?)`).run(p.id, "admin", "Автор из копии", 1000,
      "Историческое обсуждение", 2000, JSON.stringify([{
        id: originalId, name: "документ.txt", type: "text/plain", size: attachmentBytes.length,
      }]));
    await source.db.prepare(`INSERT INTO person_comments
      (person_id,author_id,author_name,created_ms,text,attachments)
      VALUES(?,?,?,?,?,?)`).run(p.id, "admin", "Автор из копии", 3000, "", JSON.stringify([{
        id: fileOnlyId, name: "только-фото.png", type: "image/png", size: fileOnlyBytes.length,
      }]));
    const bytes = await databaseBackupBytes(source.db);
    const full = gzipSync(Buffer.concat([
      entry("drevo.sqlite", bytes),
      entry(`uploads/discussion-files/${originalId}`, attachmentBytes),
      entry(`uploads/discussion-files/${fileOnlyId}`, fileOnlyBytes),
      Buffer.alloc(1024),
    ]));
    await target.db.prepare("INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,?,?,?)")
      .run(p.id, "admin", 3000, "Текущий комментарий");
    const ordinary = await restores.preview(full, admin);
    assert.equal(ordinary.backupCommentsSkipped, 2);
    await restores.apply(ordinary.token, admin, async () => {});
    assert.deepEqual((await target.db.prepare("SELECT text FROM person_comments").all())
      .map((row) => row.text), ["Текущий комментарий"]);

    const blocked = await restores.preview(full, admin, { restoreComments: true });
    assert.equal(blocked.canRestoreComments, false);
    await assert.rejects(restores.apply(blocked.token, admin, async () => {}, true),
      /комментари/i);
    await target.db.prepare("DELETE FROM person_comments").run();
    const stale = await restores.preview(full, admin, { restoreComments: true });
    assert.equal(stale.canRestoreComments, true);
    await target.db.prepare("INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,?,?,?)")
      .run(p.id, "admin", 4000, "Concurrent comment");
    await assert.rejects(restores.apply(stale.token, admin, async () => {}, true),
      /уже есть комментарии/);
    assert.deepEqual((await target.db.prepare("SELECT text FROM person_comments").all())
      .map((row) => row.text), ["Concurrent comment"]);
    await target.db.prepare("DELETE FROM person_comments").run();
    const preview = await restores.preview(full, admin, { restoreComments: true });
    assert.equal(preview.canRestoreComments, true);
    await restores.apply(preview.token, admin, async () => {}, true);
    const importedRows = await target.db.prepare(
      "SELECT author_id,author_name,created_ms,updated_ms,text,attachments FROM person_comments ORDER BY created_ms",
    ).all();
    assert.equal(importedRows.length, 2);
    const [imported, fileOnly] = importedRows;
    const files = JSON.parse(String(imported.attachments));
    assert.equal(imported.author_name, "Автор из копии");
    assert.notEqual(imported.author_id, "admin");
    assert.equal(imported.created_ms, 1000);
    assert.equal(imported.updated_ms, 2000);
    assert.equal(imported.text, "Историческое обсуждение");
    assert.notEqual(files[0].id, originalId);
    assert.deepEqual(readFileSync(join(dir, "uploads", "discussion-files", files[0].id)), attachmentBytes);
    assert.equal(fileOnly.text, "");
    assert.notEqual(fileOnly.author_id, "admin");
    const fileOnlyFiles = JSON.parse(String(fileOnly.attachments));
    assert.notEqual(fileOnlyFiles[0].id, fileOnlyId);
    assert.deepEqual(readFileSync(join(dir, "uploads", "discussion-files", fileOnlyFiles[0].id)), fileOnlyBytes);
    assert.ok(readFileSync(join(dir, "uploads", "discussion-files", `${fileOnlyFiles[0].id}.webp`)).length > 0);
    const duplicate = await restores.preview(full, admin, { restoreComments: true });
    assert.equal(duplicate.canRestoreComments, false);
    await source.db.prepare("UPDATE person_comments SET text=? WHERE created_ms=1000")
      .run("😀".repeat(1001));
    const inspected = new DatabaseSync(join(dir, "source.sqlite"), { readOnly: true });
    try {
      assert.throws(() => sourceComments(inspected, new Set([p.id])),
        /Некорректный комментарий/,
        "restore must enforce the same UTF-16 text length as comment POST");
    } finally { inspected.close(); }
    await assert.rejects(restores.apply(duplicate.token, admin, async () => {}, true),
      /комментари/i);
  } finally {
    await restores.close();
    await target.close();
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real full TAR backup restores discussion attachment originals on opt-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-full-tar-discussion-"));
  const sourcePath = join(dir, "source", "archive.sqlite");
  const targetPath = join(dir, "target", "archive.sqlite");
  mkdirSync(join(dir, "source", "uploads", "discussion-files"), { recursive: true });
  mkdirSync(join(dir, "target"), { recursive: true });
  const source = await openArchive(sourcePath, family);
  const target = await openArchive(targetPath, family);
  const restores = restoreStore(target, targetPath);
  const admin = { id: "admin", name: "Администратор", role: "admin" as const,
    createdAt: "2026-01-01T00:00:00.000Z" };
  const originalId = "a5ac420a-5ed9-44ee-a307-8550f6b64708";
  const original = Buffer.from("A discussion attachment from the real backup producer");
  const server = createServer((_req, res) => {
    void fullBackup(source.db, sourcePath, res).catch((error) => {
      if (res.headersSent) res.destroy(error as Error);
      else { res.statusCode = 500; res.end(String(error)); }
    });
  });
  try {
    writeFileSync(join(dir, "source", "uploads", "discussion-files", originalId), original);
    await source.db.prepare(`INSERT INTO person_comments
      (person_id,author_id,author_name,created_ms,text,attachments)
      VALUES(?,?,?,?,?,?)`).run(p.id, "source-user", "Автор копии", 1000,
      "Комментарий из полной копии", JSON.stringify([{
        id: originalId, name: "документ.txt", type: "text/plain", size: original.length,
      }]));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    if (response.status !== 200)
      assert.fail(`Full backup failed with ${response.status}: ${await response.text()}`);
    const backup = Buffer.from(await response.arrayBuffer());
    const raw = gunzipSync(backup);
    let end = raw.length;
    while (end >= 512 && raw.subarray(end - 512, end).every((byte) => byte === 0))
      end -= 512;
    const maliciousEntry = (name: string, type: string) =>
      gunzipSync(tar(name, Buffer.alloc(0), type)).subarray(0, -1024);
    for (const [name, type] of [
      [`uploads/discussion-files/91ab323a-5379-4da9-ae0a-b26fdba865db`, "2"],
      ["uploads/unexpected/private", "0"],
    ]) {
      const altered = gzipSync(Buffer.concat([
        raw.subarray(0, end), maliciousEntry(name, type), Buffer.alloc(1024),
      ]));
      await assert.rejects(restores.preview(altered, admin, { restoreComments: true }),
        /допустим/i, `the actual full backup must reject ${name}`);
    }
    const preview = await restores.preview(backup, admin, { restoreComments: true });
    assert.equal(preview.canRestoreComments, true);
    assert.equal(preview.backupCommentsSkipped, 1);
    await restores.apply(preview.token, admin, async () => {}, true);
    const rows = await target.db.prepare(
      "SELECT text,author_id,attachments FROM person_comments WHERE person_id=?",
    ).all(p.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, "Комментарий из полной копии");
    assert.notEqual(rows[0].author_id, "source-user");
    const restored = JSON.parse(String(rows[0].attachments)) as Array<{ id: string }>;
    assert.equal(restored.length, 1);
    assert.notEqual(restored[0].id, originalId);
    assert.deepEqual(readFileSync(join(dir, "target", "uploads", "discussion-files",
      restored[0].id)), original);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await restores.close();
    await target.close();
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing discussion original blocks only opt-in and failed import removes new files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-restore-discussion-rollback-"));
  const source = await openArchive(join(dir, "source.sqlite"), family);
  const target = await openArchive(join(dir, "target.sqlite"), family);
  const restores = restoreStore(target, join(dir, "target.sqlite"));
  const admin = { id: "admin", name: "Администратор", role: "admin" as const,
    createdAt: "2026-01-01T00:00:00.000Z" };
  const id = "a5ac420a-5ed9-44ee-a307-8550f6b64708";
  const attachment = Buffer.from("A complete source original");
  const entry = (name: string, data: Buffer) =>
    gunzipSync(tar(name, data)).subarray(0, -1024);
  try {
    await source.db.prepare(`INSERT INTO person_comments
      (person_id,author_id,author_name,created_ms,text,attachments) VALUES(?,?,?,?,?,?)`)
      .run(p.id, "source-user", "Старый автор", 1000, "С файлом", JSON.stringify([{
        id, name: "source.txt", type: "text/plain", size: attachment.length,
      }]));
    const sqlite = await databaseBackupBytes(source.db);
    const missing = gzipSync(Buffer.concat([entry("drevo.sqlite", sqlite), Buffer.alloc(1024)]));
    const missingPreview = await restores.preview(missing, admin, { restoreComments: true });
    assert.equal(missingPreview.canRestoreComments, false);
    assert.match(missingPreview.commentsRestoreReason, /оригинал/i);
    await assert.rejects(restores.apply(missingPreview.token, admin, async () => {}, true),
      /Комментарии.*не были подготовлены/);
    await restores.apply(missingPreview.token, admin, async () => {});
    assert.equal((await target.db.prepare("SELECT count(*) AS count FROM person_comments").get())?.count, 0);

    const complete = gzipSync(Buffer.concat([
      entry("drevo.sqlite", sqlite), entry(`uploads/discussion-files/${id}`, attachment),
      Buffer.alloc(1024),
    ]));
    const preview = await restores.preview(complete, admin, { restoreComments: true });
    assert.equal(preview.canRestoreComments, true);
    await assert.rejects(restores.apply(preview.token, admin, async (db) => {
      if (db) throw new Error("forced transactional failure");
    }, true), /forced transactional failure/);
    assert.equal((await target.db.prepare("SELECT count(*) AS count FROM person_comments").get())?.count, 0);
    const rows = existsSync(join(dir, "uploads", "discussion-files"))
      ? readdirSync(join(dir, "uploads", "discussion-files")) : [];
    assert.deepEqual(rows, [], "rollback must remove copied discussion originals");
    const stage = await target.db.prepare(
      "SELECT directory FROM workflow_stages WHERE token=?",
    ).get(preview.token);
    assert.equal(existsSync(join(String(stage!.directory), ".upload")), false,
      "rejected opt-in must release the staged TAR");
    await restores.apply(preview.token, admin, async () => {});
    assert.equal((await target.db.prepare("SELECT count(*) AS count FROM person_comments").get())?.count, 0,
      "ordinary restore remains available after opt-in refusal");
    const stalePreview = await restores.preview(complete, admin, { restoreComments: true });
    assert.equal(stalePreview.canRestoreComments, true);
    const staleStage = await target.db.prepare(
      "SELECT directory FROM workflow_stages WHERE token=?",
    ).get(stalePreview.token);
    await target.write(family, (await target.read()).revision);
    await assert.rejects(restores.apply(stalePreview.token, admin, async () => {}, true),
      /архив изменился/);
    assert.equal(existsSync(join(String(staleStage!.directory), ".upload")), false,
      "a stale opt-in apply must release its retained TAR");
  } finally {
    await restores.close();
    await target.close();
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("backup preview is read-only; confirmed SQLite import preserves access, snapshots old data and checks revisions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-import-test-")),
    app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (
    part: string,
    body: Buffer | object,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + "/api/restore/" + part, {
      method: "POST",
      headers: { "X-Drevo-Restore": "1", ...headers },
      body: Buffer.isBuffer(body)
        ? new Uint8Array(body).buffer
        : JSON.stringify(body),
    });
  try {
    await app.archive.write(family, (await app.archive.read()).revision);
    const bytes = await databaseBackupBytes(app.archive.db);
    const changed = {
      ...family,
      title: "После бэкапа",
      people: [{ ...p, name: "Мария" }],
    };
    await app.archive.write(changed, (await app.archive.read()).revision);
    await (await userStore(app.archive.db)).register("owner", "Владелец");
    await (
      await settingsStore(app.archive.db)
    ).write({
      publicTree: false,
      publicAlbums: false,
      reverseTimeline: true,
    });
    let response = await request("preview", bytes);
    assert.equal(response.status, 200);
    let preview = await response.json();
    assert.equal(preview.people, 1);
    assert.equal((await app.archive.read()).family.people[0].name, "Мария");
    assert.equal(
      (await request("apply", { token: preview.token })).status,
      400,
    );
    await app.archive.write(
      { ...changed, description: "Поздняя правка" },
      (await app.archive.read()).revision,
    );
    assert.equal(
      (await request("apply", { token: preview.token, confirm: true })).status,
      409,
    );
    response = await request("preview", bytes);
    preview = await response.json();
    const before = await app.archive.read(),
      imported = await request("apply", {
        token: preview.token,
        confirm: true,
      });
    assert.equal(imported.status, 200);
    const result = await imported.json();
    assert.equal(result.revision, before.revision + 1);
    assert.equal(result.family.people[0].name, "Анна");
    assert.equal(
      (await (await userStore(app.archive.db)).get("owner"))!.role,
      "admin",
    );
    assert.equal(
      (await (await settingsStore(app.archive.db)).read()).publicTree,
      false,
    );
    const old = new DatabaseSync(join(dir, "backups", result.backupName), {
      readOnly: true,
    });
    assert.equal(
      (await readArchive(storeDatabase(old))).family.description,
      "Поздняя правка",
    );
    old.close();
    assert.equal(
      (await request("apply", { token: preview.token, confirm: true })).status,
      400,
    );
    assert.equal(
      (await request("preview", bytes, { Origin: "https://other.example" }))
        .status,
      403,
    );
    const originalKey = Buffer.alloc(32, 1);
    writeFileSync(join(dir, "drevo.sqlite.secrets.key"), originalKey);
    const withKey = gzipSync(
      Buffer.concat([
        gunzipSync(tar("drevo.sqlite", bytes)).subarray(0, -1024),
        gunzipSync(tar("drevo.sqlite.secrets.key", Buffer.alloc(32, 2))),
      ]),
    );
    const keyPreview = await request("preview", withKey);
    assert.equal(keyPreview.status, 200);
    const keyImport = await request("apply", {
      token: (await keyPreview.json()).token,
      confirm: true,
    });
    assert.equal(keyImport.status, 200);
    assert.deepEqual(
      readFileSync(join(dir, "drevo.sqlite.secrets.key")),
      originalKey,
    );
    const restoredRevision = (await app.archive.meta()).revision;
    for (const bad of [
      Buffer.from("not a database"),
      tar("../../escape.sqlite", bytes),
      tar("uploads/link.jpg", Buffer.alloc(0), "2"),
      tar("drevo.sqlite.secrets.key", Buffer.alloc(33)),
      tar("drevo.sqlite", Buffer.alloc(0), "0", 100 * 1024 * 1024),
      bytes.subarray(0, 200),
    ]) {
      assert.equal((await request("preview", bad)).status, 400);
      assert.equal((await app.archive.read()).revision, restoredRevision);
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full downloaded backup restores portrait, gallery and tags without overwriting existing photo files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-full-import-test-")),
    app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    writeFileSync(join(dir, "uploads", "original.png"), png);
    writeFileSync(join(dir, "uploads", ".unfinished.upload"), "unfinished");
    const privateId = "a5ac420a-5ed9-44ee-a307-8550f6b64708";
    mkdirSync(join(dir, "uploads", "discussion-files"));
    writeFileSync(
      join(dir, "uploads", "discussion-files", privateId),
      "discussion",
    );
    mkdirSync(join(dir, "uploads", "ai-chat-files", privateId), {
      recursive: true,
    });
    writeFileSync(
      join(dir, "uploads", "ai-chat-files", privateId, privateId),
      "chat",
    );
    await app.archive.write(
      {
        ...family,
        people: [{ ...p, photo: "/media/original.png" }],
        photos: [
          {
            id: "photo",
            title: "Снимок",
            url: "/media/original.png",
            tags: [
              {
                id: "tag",
                personId: p.id,
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.3,
              },
            ],
          },
        ],
      },
      (await app.archive.read()).revision,
    );
    const full = Buffer.from(
      await (await fetch(base + "/api/backup/full")).arrayBuffer(),
    );
    await app.archive.write(
      { ...family, people: [] },
      (await app.archive.read()).revision,
    );
    const previewResponse = await fetch(base + "/api/restore/preview", {
      method: "POST",
      headers: { "X-Drevo-Restore": "1" },
      body: full,
    });
    assert.equal(
      previewResponse.status,
      200,
      await previewResponse.clone().text(),
    );
    const preview = await previewResponse.json();
    assert.equal(preview.files, 1);
    assert.equal(preview.missing, 0);
    const response = await fetch(base + "/api/restore/apply", {
      method: "POST",
      headers: { "X-Drevo-Restore": "1" },
      body: JSON.stringify({ token: preview.token, confirm: true }),
    });
    assert.equal(response.status, 200);
    const { family: restored } = await response.json();
    assert.equal(restored.photos[0].tags[0].personId, p.id);
    assert.equal(restored.people[0].photo, restored.photos[0].url);
    assert.notEqual(restored.photos[0].url, "/media/original.png");
    const original = await app.archive.db
      .prepare("SELECT size_bytes,uploaded_by FROM media_originals WHERE url=?")
      .get(restored.photos[0].url);
    assert.equal(original?.size_bytes, png.length);
    assert.equal(typeof original?.uploaded_by, "string");
    assert.deepEqual(readFileSync(join(dir, "uploads", "original.png")), png);
    assert.deepEqual(
      Buffer.from(
        await (await fetch(base + restored.photos[0].url)).arrayBuffer(),
      ),
      png,
    );
    assert.equal(
      readdirSync(join(dir, "uploads")).filter((name) => name.endsWith(".png"))
        .length,
      2,
    );
    assert.equal(
      readFileSync(join(dir, "uploads", "discussion-files", privateId), "utf8"),
      "discussion",
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
