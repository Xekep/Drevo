import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createServer } from "node:http";
import { startServer } from "../src/server/index.ts";
import { sharesStore } from "../src/server/shares.ts";
import { publicSharingHttp } from "../src/server/public-sharing-http.ts";
import type { openArchive } from "../src/server/database.ts";
import { mediaStore } from "../src/server/media.ts";
import type { imagePreviews } from "../src/server/image-previews.ts";
import type { ArchiveUser, Family } from "../src/domain/index.ts";

const actor: ArchiveUser = {
  id: "admin",
  name: "Администратор теста",
  role: "admin",
  createdAt: "",
};

const family = (photo: string): Family => ({
  title: "Shared portrait",
  description: "",
  demo: false,
  people: [
    {
      id: "person",
      name: "Иван",
      surname: "Тестов",
      patronymic: "",
      sex: "m",
      birth: "1950",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      generation: 1,
      column: 0,
      photo,
    },
  ],
  photos: [],
});

test("shared portrait uses path previews and streams GIF originals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-shared-portrait-")),
    uploads = join(directory, "uploads");
  mkdirSync(uploads, { recursive: true });
  const png = await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 220, g: 210, b: 190 },
    },
  })
    .png()
    .toBuffer();
  const gif = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    "base64",
  );
  writeFileSync(join(uploads, "shared.png"), png);
  writeFileSync(join(uploads, "shared.gif"), gif);

  const app = await startServer(0, join(directory, "archive.sqlite"), true),
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await app.archive.write(
      family("/media/shared.png"),
      (await app.archive.meta()).revision,
    );
    const issued = await sharesStore(app.archive.db).create(
      {
        title: "Часть семьи",
        anchorId: "person",
        personIds: ["person"],
        durationHours: 1,
      },
      (await app.archive.read()).family,
      actor,
    );
    const portrait = `/api/shared/${issued.token}/portrait/person`;

    const previewResponse = await fetch(base + portrait);
    assert.equal(previewResponse.status, 200);
    assert.equal(previewResponse.headers.get("content-type"), "image/webp");
    const preview = Buffer.from(await previewResponse.arrayBuffer()),
      metadata = await sharp(preview).metadata();
    assert.equal(metadata.format, "webp");
    assert.ok((metadata.width || 0) <= 400);
    assert.ok((metadata.height || 0) <= 400);
    const tinyResponse = await fetch(base + portrait + "?variant=tiny");
    assert.equal(tinyResponse.status, 200);
    const tinyMeta = await sharp(
      Buffer.from(await tinyResponse.arrayBuffer()),
    ).metadata();
    assert.ok((tinyMeta.width || 0) <= 48);
    assert.ok((tinyMeta.height || 0) <= 48);

    for (const path of [portrait, "/media/shared.png"]) {
      const response = await fetch(base + path + "?variant=avatar");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/webp");
      assert.match(response.headers.get("cache-control") || "", /no-store/);
      const bytes = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.width, 128);
      assert.equal(metadata.height, 96);
      const pixels = await sharp(bytes).raw().toBuffer();
      assert.ok(pixels[0] - pixels[2] > 15, "compact portraits keep colour");
    }
    assert.equal((await fetch(base + portrait.replace("/person", "/unshared") + "?variant=avatar")).status, 404);
    assert.equal((await fetch(base + portrait.replace(issued.token, "b".repeat(43)) + "?variant=avatar")).status, 410);

    const current = await app.archive.read(),
      withGif = structuredClone(current.family);
    withGif.people[0].photo = "/media/shared.gif";
    await app.archive.write(withGif, current.revision);

    const gifResponse = await fetch(base + portrait);
    assert.equal(gifResponse.status, 200);
    assert.equal(gifResponse.headers.get("content-type"), "image/gif");
    assert.equal(gifResponse.headers.get("content-length"), String(gif.length));
    assert.deepEqual(Buffer.from(await gifResponse.arrayBuffer()), gif);
    const compactGif = await fetch(base + portrait + "?variant=avatar");
    assert.equal(compactGif.headers.get("content-type"), "image/gif");
    assert.deepEqual(Buffer.from(await compactGif.arrayBuffer()), gif);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared portrait handler cannot regress to synchronous media.read", () => {
  const source = readFileSync("src/server/public-sharing-http.ts", "utf8");
  assert.doesNotMatch(source, /media\.read\s*\(/);
  assert.match(source, /media\.open\s*\(/);
  assert.match(source, /pipeline\s*\(/);
});

test("shared preview does not release a portrait replaced during generation", async () => {
  const token = "a".repeat(43);
  let currentFamily = family("/media/old.png");
  let previewStarted!: () => void;
  let finishPreview!: () => void;
  const started = new Promise<void>((resolve) => {
    previewStarted = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    finishPreview = resolve;
  });
  const handler = publicSharingHttp({
    archive: {
      read: async () => ({ family: currentFamily }),
    } as Awaited<ReturnType<typeof openArchive>>,
    media: {
      open: (url: string) => ({
        path: url,
        name: "old.png",
        type: "image/png",
      }),
    } as ReturnType<typeof mediaStore>,
    previewImage: (async () => {
      previewStarted();
      await resume;
      return Buffer.from("old portrait preview");
    }) as ReturnType<typeof imagePreviews>,
    shares: {
      get: async () => ({ personIds: ["person"] }),
    } as unknown as ReturnType<typeof sharesStore>,
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://localhost")).catch(
      (error) => {
        res.destroy(error);
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = fetch(
      `http://127.0.0.1:${port}/api/shared/${token}/portrait/person?variant=avatar`,
    );
    await started;
    currentFamily = family("/media/new.png");
    finishPreview();
    const result = await response;
    assert.equal(result.status, 404);
    assert.notEqual(await result.text(), "old portrait preview");
  } finally {
    finishPreview();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("shared GIF original does not stream after its portrait changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-shared-gif-race-"));
  const uploads = join(directory, "uploads");
  mkdirSync(uploads);
  writeFileSync(
    join(uploads, "old.gif"),
    Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
  );
  let currentFamily = family("/media/old.gif");
  let recheckStarted!: () => void;
  let finishRecheck!: () => void;
  const started = new Promise<void>((resolve) => {
    recheckStarted = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    finishRecheck = resolve;
  });
  let lookups = 0;
  const handler = publicSharingHttp({
    archive: {
      read: async () => ({ family: currentFamily }),
    } as Awaited<ReturnType<typeof openArchive>>,
    media: mediaStore(uploads),
    previewImage: (async () => {
      throw new Error("GIF must stream unchanged");
    }) as ReturnType<typeof imagePreviews>,
    shares: {
      get: async () => {
        if (++lookups === 2) {
          recheckStarted();
          await resume;
        }
        return { personIds: ["person"] };
      },
    } as unknown as ReturnType<typeof sharesStore>,
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://localhost")).catch(
      (error) => {
        res.destroy(error);
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const pending = fetch(
      `http://127.0.0.1:${port}/api/shared/${"a".repeat(43)}/portrait/person`,
    );
    await started;
    currentFamily = family("/media/new.gif");
    finishRecheck();
    const response = await pending;
    assert.equal(response.status, 404);
  } finally {
    finishRecheck();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});
