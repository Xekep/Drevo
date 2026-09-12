import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import {
  MediaTooLargeError,
  mediaStore,
} from "../src/server/media.ts";

test("streamed media keeps exact bytes when the signature is split across chunks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-media-stream-"));
  try {
    const pngLike = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "green" },
    }).png().toBuffer();
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
