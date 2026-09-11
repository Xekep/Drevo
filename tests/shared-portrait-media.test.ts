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
import { startServer } from "../src/server/index.ts";
import { sharesStore } from "../src/server/shares.ts";
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
    app.archive.write(family("/media/shared.png"), app.archive.meta().revision);
    const issued = sharesStore(app.archive.db).create(
      {
        title: "Часть семьи",
        anchorId: "person",
        personIds: ["person"],
        durationHours: 1,
      },
      app.archive.read().family,
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

    const current = app.archive.read(),
      withGif = structuredClone(current.family);
    withGif.people[0].photo = "/media/shared.gif";
    app.archive.write(withGif, current.revision);

    const gifResponse = await fetch(base + portrait);
    assert.equal(gifResponse.status, 200);
    assert.equal(gifResponse.headers.get("content-type"), "image/gif");
    assert.equal(gifResponse.headers.get("content-length"), String(gif.length));
    assert.deepEqual(Buffer.from(await gifResponse.arrayBuffer()), gif);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared portrait handler cannot regress to synchronous media.read", () => {
  const source = readFileSync("src/server/sharing-http.ts", "utf8");
  assert.doesNotMatch(source, /media\.read\s*\(/);
  assert.match(source, /media\.open\s*\(/);
  assert.match(source, /pipeline\s*\(/);
});
