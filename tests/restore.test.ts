import { storeDatabase } from "../src/server/store-database.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
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
import { databaseBackupBytes } from "./helpers/database-backup.ts";
import { readArchive } from "../src/server/database.ts";
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
    assert.deepEqual(readFileSync(join(dir, "uploads", "original.png")), png);
    assert.deepEqual(
      Buffer.from(
        await (await fetch(base + restored.photos[0].url)).arrayBuffer(),
      ),
      png,
    );
    assert.equal(
      readdirSync(join(dir, "uploads")).filter((name) => !name.startsWith("."))
        .length,
      2,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
