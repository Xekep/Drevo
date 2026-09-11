import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  IMAGE_PREVIEW_CACHE_VERSION,
  IMAGE_PREVIEW_SETTINGS,
  imagePreviews,
} from "../src/server/image-previews.ts";

test("photo previews use lossy webp settings and a new cache generation", () => {
  assert.equal(IMAGE_PREVIEW_CACHE_VERSION, 2);
  assert.deepEqual(IMAGE_PREVIEW_SETTINGS.thumb, {
    maxSize: 400,
    quality: 76,
  });
  assert.deepEqual(IMAGE_PREVIEW_SETTINGS.display, {
    maxSize: 1600,
    quality: 82,
  });
  assert.ok(IMAGE_PREVIEW_SETTINGS.display.quality < 100);
});

test("photo previews keep expected dimensions and cache variant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-previews-"));
  try {
    const original = await sharp({
      create: {
        width: 2400,
        height: 1800,
        channels: 3,
        background: { r: 96, g: 128, b: 160 },
      },
    })
      .jpeg({ quality: 95 })
      .toBuffer();
    const preview = imagePreviews(directory);

    const display = await preview(original, "display");
    const displayMeta = await sharp(display).metadata();
    assert.equal(displayMeta.format, "webp");
    assert.equal(displayMeta.width, 1600);
    assert.equal(displayMeta.height, 1200);

    const thumb = await preview(original, "thumb");
    const thumbMeta = await sharp(thumb).metadata();
    assert.equal(thumbMeta.format, "webp");
    assert.equal(thumbMeta.width, 400);
    assert.equal(thumbMeta.height, 300);

    const files = await readdir(directory);
    assert.equal(files.length, 2);
    assert.ok(files.some((file) => file.endsWith("-display-v2.webp")));
    assert.ok(files.some((file) => file.endsWith("-thumb-v2.webp")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cached path preview does not need the original file again", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-preview-path-"));
  const directory = join(root, "cache");
  const sourcePath = join(root, "immutable-photo.jpg");
  try {
    const original = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 120, g: 90, b: 70 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    await writeFile(sourcePath, original);
    const preview = imagePreviews(directory);
    const source = { path: sourcePath, cacheKey: "immutable-photo.jpg" };

    const first = await preview(source, "thumb");
    await unlink(sourcePath);
    const cached = await preview(source, "thumb");

    assert.deepEqual(cached, first);
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
