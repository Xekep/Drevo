import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, stat, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { startServer } from "../src/server/index.ts";
import { userStore } from "../src/server/users.ts";
import { userStorageBytes } from "../src/server/storage-limits.ts";
import {
  prepareCommentAttachments,
  prepareCommentFile,
  discussionAttachmentStore,
} from "../src/server/discussion-attachments.ts";
import type { PersonComment } from "../src/shared/person-discussion.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { installPortableOriginals } from "../src/server/portable-install.ts";
import { initializeArchiveSchema } from "../src/server/schema.ts";

test("discussion files remain private, preserve edit conflicts, count toward quotas and disappear on deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-comment-files-"));
  const originalOrigin = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://archive.test";
  const app = await startServer(0, join(directory, "drevo.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const db = app.archive.db;
  async function login(id: string, seed: string) {
    await (await userStore(db)).register(id, id);
    const token = seed.repeat(64);
    await db
      .prepare(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      )
      .run(
        createHash("sha256").update(token).digest("hex"),
        id,
        Date.now() + 3600_000,
      );
    return `drevo_session=${token}`;
  }
  function request(
    path: string,
    cookie = "",
    method = "GET",
    body?: unknown,
    origin = "https://archive.test",
  ) {
    return fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  try {
    const snapshot = await app.archive.read();
    const people = ["anna", "boris"].map((id) => ({
      id,
      name: id,
      surname: "Тестов",
      patronymic: "",
      sex: "u" as const,
      birth: "",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      column: 0,
      generation: 1,
    }));
    await app.archive.write(
      { title: "Вложения", description: "", people, demo: false },
      snapshot.revision,
    );
    const admin = await login("admin", "a");
    const reader = await login("reader", "b");
    const other = await login("other", "c");
    await db
      .prepare(
        "UPDATE users SET approved=1,tree_access='common_ancestors',person_id='boris' WHERE id='reader'",
      )
      .run();
    await db.prepare("UPDATE users SET approved=1 WHERE id='other'").run();
    const endpoint = "/api/people/anna/discussion";
    assert.equal((await request(`${endpoint}?count=1`)).status, 401);
    assert.equal((await request(`${endpoint}?count=1`, reader)).status, 404);
    assert.deepEqual(
      await (await request(`${endpoint}?count=1`, admin)).json(),
      { total: 0 },
    );
    const image = await sharp({
      create: { width: 800, height: 400, channels: 3, background: "#eaaf62" },
    })
      .png()
      .toBuffer();
    const text = Buffer.from("<script>alert(1)</script>\nПисьмо");
    const input = {
      text: "",
      attachments: {
        keep: [],
        files: [
          { name: "Снимок.png", data: image.toString("base64") },
          { name: "Письмо.txt", data: text.toString("base64") },
        ],
      },
    };
    assert.equal(
      (await request(endpoint, admin, "POST", input, "https://other.test"))
        .status,
      403,
    );
    const created = await request(endpoint, admin, "POST", input);
    assert.equal(created.status, 201);
    const result = (await created.json()) as {
      item: PersonComment;
      total: number;
    };
    assert.equal(result.total, 1);
    assert.equal(result.item.text, "");
    assert.equal(result.item.attachments.length, 2);
    const [photo, note] = result.item.attachments;
    assert.equal(
      await userStorageBytes(db, "admin"),
      image.length + text.length,
    );
    assert.equal((await request(photo.url)).status, 401);
    assert.equal((await request(photo.url, reader)).status, 404);
    const original = await request(photo.url, other);
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), image);
    const preview = await request(photo.previewUrl!, other);
    assert.equal(preview.headers.get("content-type"), "image/webp");
    const dimensions = await sharp(
      Buffer.from(await preview.arrayBuffer()),
    ).metadata();
    assert.equal(dimensions.width, 480);
    assert.equal(dimensions.height, 240);
    const download = await request(note.url, other);
    assert.match(download.headers.get("content-disposition")!, /^attachment;/);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.match(download.headers.get("content-security-policy")!, /sandbox/);
    assert.equal(await download.text(), text.toString());
    const editUrl = `${endpoint}/${result.item.id}`;
    assert.equal(
      (
        await request(editUrl, other, "PATCH", {
          text: "Чужая правка",
          editedAt: null,
        })
      ).status,
      403,
    );
    const replacement = Buffer.from("Новое письмо");
    const edited = await request(editUrl, admin, "PATCH", {
      text: "Правка",
      editedAt: null,
      attachments: {
        keep: [photo.id],
        files: [{ name: "Новый.txt", data: replacement.toString("base64") }],
      },
    });
    assert.equal(edited.status, 200);
    const current = (await edited.json()).item as PersonComment;
    assert.ok(current.editedAt);
    assert.equal(current.attachments[0].id, photo.id);
    assert.equal((await request(note.url, admin)).status, 404);
    assert.equal(
      await userStorageBytes(db, "admin"),
      image.length + replacement.length,
    );
    const before = (
      await readdir(join(directory, "uploads", "discussion-files"))
    ).sort();
    const stale = await request(editUrl, admin, "PATCH", {
      text: "Старая правка",
      editedAt: null,
      attachments: {
        keep: [],
        files: [
          { name: "Не сохранять.txt", data: replacement.toString("base64") },
        ],
      },
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(
      (await readdir(join(directory, "uploads", "discussion-files"))).sort(),
      before,
    );
    assert.equal(
      (
        await request(editUrl, admin, "PATCH", {
          text: "",
          editedAt: current.editedAt,
          attachments: { keep: [], files: [] },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(editUrl, admin, "PATCH", {
          text: "Правка",
          editedAt: current.editedAt,
          attachments: { keep: [note.id], files: [] },
        })
      ).status,
      400,
    );
    const denied = await request(
      "/api/people/boris/discussion",
      reader,
      "POST",
      {
        text: "Файл",
        attachments: {
          keep: [],
          files: [{ name: "Письмо.txt", data: text.toString("base64") }],
        },
      },
    );
    assert.equal(denied.status, 507);
    assert.deepEqual(
      (await readdir(join(directory, "uploads", "discussion-files"))).sort(),
      before,
    );
    const deleted = await request(editUrl, admin, "DELETE");
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).total, 0);
    assert.equal(await userStorageBytes(db, "admin"), 0);
    assert.equal((await request(photo.url, admin)).status, 404);
    await assert.rejects(
      stat(join(directory, "uploads", "discussion-files", photo.id)),
      { code: "ENOENT" },
    );
    assert.deepEqual(
      await readdir(join(directory, "uploads", "discussion-files")),
      [],
    );
    // The badge reports all messages, rather than just the first page of twenty.
    for (let i = 0; i < 21; i++)
      await db
        .prepare(
          "INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text) VALUES(?,?,?,?,?)",
        )
        .run("anna", "admin", "Автор", Date.now(), `Сообщение ${i}`);
    const page = await (await request(endpoint, admin)).json();
    assert.equal(page.total, 21);
    assert.equal(page.items.length, 20);
    assert.equal(
      (
        await (
          await request(`${endpoint}?before=${page.nextBefore}`, admin)
        ).json()
      ).total,
      21,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      app.server.close((error) => (error ? reject(error) : resolve())),
    );
    app.archive.db.close();
    if (originalOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = originalOrigin;
    await rm(directory, { recursive: true, force: true });
  }
});

test("attachment validation rejects active formats, false MIME, paths and invalid encoding", async () => {
  for (const name of [
    "page.html",
    "graphic.svg",
    "../file.txt",
    "file\n.txt",
    "file\ud800.txt",
  ])
    await assert.rejects(prepareCommentFile(name, Buffer.from("text")));
  await assert.rejects(
    prepareCommentFile("image.png", Buffer.from("not an image")),
  );
  await assert.rejects(
    prepareCommentFile("file.pdf", Buffer.from("not a PDF")),
  );
  await assert.rejects(prepareCommentFile("text.txt", Buffer.from([0xff])));
  await assert.rejects(
    prepareCommentAttachments({
      keep: [],
      files: [{ name: "file.txt", data: "YQ" }],
    }),
  );
  await assert.rejects(
    prepareCommentAttachments({ keep: Array(9).fill("missing"), files: [] }),
  );
});

test("portable archives preserve comment files and recreate private previews with fresh IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-comment-portable-"));
  try {
    const uploads = join(directory, "uploads");
    const image = await sharp({
      create: { width: 120, height: 80, channels: 3, background: "#88a871" },
    })
      .png()
      .toBuffer();
    const saved = await discussionAttachmentStore(uploads).save([
      await prepareCommentFile("Снимок.png", image),
      await prepareCommentFile("Письмо.txt", Buffer.from("Содержание письма")),
    ]);
    const packet = join(directory, "family.drevo");
    await writePortablePackage(
      createWriteStream(packet),
      uploads,
      {
        family: {
          title: "Архив",
          description: "",
          people: [
            {
              id: "p",
              name: "Пётр",
              surname: "Тестов",
              patronymic: "",
              birth: "",
              birthPlace: "",
              sex: "m",
              parents: [],
              spouses: [],
              sources: [],
              column: 0,
              generation: 1,
            },
          ],
          demo: false,
        },
        documents: [],
        comments: [
          {
            id: 1,
            personId: "p",
            authorId: "old-author",
            authorName: "Автор",
            createdMs: 1,
            text: "",
            attachments: saved,
          },
        ],
      },
      async () => {},
    );
    const unpack = join(directory, "unpack");
    await mkdir(unpack);
    const parsed = await readPortablePackage(packet, unpack);
    assert.equal(parsed.snapshot.comments[0].attachments?.length, 2);
    const imported = join(directory, "imported");
    const installed = await installPortableOriginals(parsed, imported);
    const files = installed.snapshot.comments[0].attachments!;
    assert.notEqual(files[0].id, saved[0].id);
    assert.deepEqual(
      await readFile(join(imported, "discussion-files", files[0].id)),
      image,
    );
    assert.equal(
      (
        await sharp(
          await readFile(
            join(imported, "discussion-files", `${files[0].id}.webp`),
          ),
        ).metadata()
      ).format,
      "webp",
    );
    assert.equal(
      installed.snapshot.comments[0].authorId,
      "imported:old-author",
    );
    await installed.undo();
    assert.deepEqual(await readdir(join(imported, "discussion-files")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adding comment attachments preserves old edits and the AUTOINCREMENT high watermark", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    db.prepare("INSERT INTO people(id,data) VALUES(?,?)").run("p", "{}");
    db.exec(`DROP TABLE person_comments;
      CREATE TABLE person_comments(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL, author_name TEXT NOT NULL DEFAULT '', created_ms INTEGER NOT NULL,
        text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2000), updated_ms INTEGER);
      INSERT INTO person_comments VALUES(7,'p','author','Автор',1,'Старая правка',2);
      INSERT INTO person_comments VALUES(100,'p','author','Автор',1,'Удалённое сообщение',NULL);
      DELETE FROM person_comments WHERE id=100;`);
    initializeArchiveSchema(db);
    const preserved = db
      .prepare(
        "SELECT text,updated_ms,attachments FROM person_comments WHERE id=7",
      )
      .get();
    assert.deepEqual(
      { ...preserved },
      { text: "Старая правка", updated_ms: 2, attachments: "[]" },
    );
    const next = db
      .prepare(
        "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES('p','author',1,'Следующее')",
      )
      .run();
    assert.equal(Number(next.lastInsertRowid), 101);
    assert.throws(() =>
      db.exec(
        "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES('p','author',1,'')",
      ),
    );
  } finally {
    db.close();
  }
});
