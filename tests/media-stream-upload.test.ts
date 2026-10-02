import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { startServer } from "../src/server/index.ts";
import type { Family } from "../src/domain/types.ts";
import { MediaTooLargeError, mediaStore } from "../src/server/media.ts";
import { indexReferencedMediaOriginals } from "../src/server/media-originals.ts";

test("a quota check can bypass another process's cached media usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-fresh-media-"));
  try {
    const media = mediaStore(directory);
    writeFileSync(join(directory, "one.jpg"), "a");
    assert.deepEqual(await media.usage(), { files: 1, bytes: 1 });
    writeFileSync(join(directory, "two.jpg"), "bb");
    assert.deepEqual(await media.usage(), { files: 1, bytes: 1 });
    assert.deepEqual(await media.usage(true), { files: 2, bytes: 3 });
    writeFileSync(join(directory, "one.jpg"), "aaaa");
    assert.deepEqual(await media.usage(true), { files: 2, bytes: 6 });
    unlinkSync(join(directory, "two.jpg"));
    assert.deepEqual(await media.usage(true), { files: 1, bytes: 4 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a quota check fails closed when its media directory disappears", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-missing-media-"));
  const media = mediaStore(directory);
  rmSync(directory, { recursive: true, force: true });
  await assert.rejects(media.usage(true), { code: "ENOENT" });
});

test("streamed media keeps exact bytes when the signature is split across chunks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-media-stream-"));
  try {
    const pngLike = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const media = mediaStore(directory);
    const file = await media.addStream(
      Readable.from([
        pngLike.subarray(0, 2),
        pngLike.subarray(2, 7),
        pngLike.subarray(7, 11),
        pngLike.subarray(11),
      ]),
      1024,
    );
    assert.match(file.url, /^\/media\/[a-f0-9-]+\.png$/);
    assert.equal(file.size, pngLike.length);
    const opened = media.open(file.url);
    assert.ok(opened);
    assert.deepEqual(readFileSync(opened.path), pngLike);
    assert.deepEqual(readdirSync(directory), [opened.name]);

    await file.undo();
    assert.equal(existsSync(opened.path), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("oversized streamed media is rejected and leaves no temporary file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-media-limit-"));
  try {
    const media = mediaStore(directory);
    await assert.rejects(
      media.addStream(
        Readable.from([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]),
          Buffer.alloc(32),
        ]),
        20,
      ),
      (error) =>
        error instanceof MediaTooLargeError &&
        error.limit === 20 &&
        error.message.includes("Максимальный размер"),
    );
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("upload HTTP handler does not collect the whole request in memory", () => {
  const source = readFileSync("src/server/media-upload-http.ts", "utf8");
  assert.doesNotMatch(source, /const chunks|Buffer\.concat/);
  assert.match(source, /media\.addStream\s*\(req, MAX_UPLOAD\)/);
});

test("media store does not expose whole-file synchronous I/O", () => {
  const source = readFileSync("src/server/media.ts", "utf8");
  assert.doesNotMatch(source, /\b(?:readFileSync|writeFileSync)\b/);
});

test("photo upload reserves space shared with pending document uploads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-shared-media-quota-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const now = Date.now();
    await app.archive.db
      .prepare(
        "INSERT INTO document_upload_requests(id,user_id,started_ms,expires_ms,reserved_bytes) VALUES(?,?,?,?,?)",
      )
      .run(
        "pending-document",
        "another-user",
        now,
        now + 60_000,
        10 * 1024 ** 3 - 1,
      );
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const response = await fetch(`${base}/api/photos`, {
      method: "POST",
      headers: {
        "X-Drevo-Upload": "1",
        "If-Match": String((await app.archive.meta()).revision),
      },
      body: new Uint8Array(image).buffer,
    });
    assert.equal(response.status, 507, await response.clone().text());
    assert.deepEqual(readdirSync(join(directory, "uploads")), []);
    await app.archive.db
      .prepare(
        "UPDATE document_upload_requests SET reserved_bytes=? WHERE id='pending-document'",
      )
      .run(10 * 1024 ** 3 - image.length);
    const fitsExactly = await fetch(`${base}/api/photos`, {
      method: "POST",
      headers: {
        "X-Drevo-Upload": "1",
        "If-Match": String((await app.archive.meta()).revision),
      },
      body: new Uint8Array(image).buffer,
    });
    assert.equal(
      fitsExactly.status,
      201,
      "known-size uploads reserve their actual bytes",
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("portrait size is recorded once and a referenced original is recovered on restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-media-originals-"));
  const path = join(directory, "archive.sqlite");
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer(0, path, true);
    const family: Family = {
      title: "Учёт фото",
      description: "",
      demo: false,
      people: [
        {
          id: "one",
          surname: "Тестов",
          name: "Иван",
          patronymic: "",
          sex: "m",
          birth: "1980",
          birthPlace: "",
          parents: [],
          spouses: [],
          generation: 1,
          column: 0,
          sources: [],
        },
      ],
    };
    await app.archive.write(family, (await app.archive.meta()).revision);
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const response = await fetch(`${base}/api/portraits`, {
      method: "POST",
      headers: {
        "X-Drevo-Upload": "1",
        "If-Match": String((await app.archive.meta()).revision),
      },
      body: new Uint8Array(image).buffer,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const { url } = (await response.json()) as { url: string };
    const stored = await app.archive.db
      .prepare("SELECT size_bytes FROM media_originals WHERE url=?")
      .get(url);
    assert.equal(stored?.size_bytes, image.length);

    const rejected = await fetch(`${base}/api/photos`, {
      method: "POST",
      headers: {
        "X-Drevo-Upload": "1",
        "If-Match": String((await app.archive.meta()).revision),
        "X-Photo-Metadata": "%",
      },
      body: new Uint8Array(image).buffer,
    });
    assert.equal(rejected.status, 400);
    assert.equal(
      (
        await app.archive.db
          .prepare("SELECT count(*) AS count FROM media_originals")
          .get()
      )?.count,
      1,
    );
    assert.equal(readdirSync(join(directory, "uploads")).length, 1);

    family.people[0].photo = url;
    await app.archive.write(family, (await app.archive.meta()).revision);
    await app.archive.db
      .prepare("DELETE FROM media_originals WHERE url=?")
      .run(url);
    await app.close();
    app = await startServer(0, path, true);
    const recovered = await app.archive.db
      .prepare("SELECT size_bytes FROM media_originals WHERE url=?")
      .get(url);
    assert.equal(recovered?.size_bytes, image.length);
    const store = mediaStore(join(directory, "uploads"));
    assert.deepEqual(
      await indexReferencedMediaOriginals(app.archive.db, family, store),
      { indexed: 0, missing: 0 },
    );
    unlinkSync(join(directory, "uploads", url.slice("/media/".length)));
    assert.deepEqual(
      await indexReferencedMediaOriginals(app.archive.db, family, store),
      { indexed: 0, missing: 1 },
    );
    const citation = structuredClone(family);
    delete citation.people[0].photo;
    citation.people[0].sources = [{ title: "Scan", type: "archive", reference: "",
      url: "/media/evidence.pdf#page=2" }];
    const evidence = Buffer.from("%PDF-1.4\ncitation original");
    writeFileSync(join(directory, "uploads", "evidence.pdf"), evidence);
    assert.deepEqual(await indexReferencedMediaOriginals(app.archive.db, citation, store),
      { indexed: 1, missing: 0 });
    assert.equal((await app.archive.db.prepare(
      "SELECT size_bytes FROM media_originals WHERE url='/media/evidence.pdf'",
    ).get())?.size_bytes, evidence.length);
    await app.archive.db.prepare("DELETE FROM media_originals WHERE url='/media/evidence.pdf'").run();
    await app.archive.db.prepare(`INSERT INTO documents
      (id,title,title_search,file_name,file_size,uploaded_by,created_at)
      VALUES('evidence','Scan','scan','evidence.pdf',?,'local','2026-10-02')`).run(evidence.length);
    assert.deepEqual(await indexReferencedMediaOriginals(app.archive.db, citation, store),
      { indexed: 0, missing: 0 }, "a catalogued document is already counted by file_size");
  } finally {
    await app?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
