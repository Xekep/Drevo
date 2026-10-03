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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "../src/server/index.ts";
import { openArchive, readArchive } from "../src/server/database.ts";
import { restoreStore } from "../src/server/restore.ts";
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

test("full backup restores citation-only originals, remaps shared media and retains page suffixes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-restore-citations-"));
  const source = await startServer(
    0,
    join(directory, "source", "drevo.sqlite"),
    true,
  );
  let target: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF",
    );
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
