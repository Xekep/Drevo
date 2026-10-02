import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, readdir, rm, unlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  IMAGE_PREVIEW_CACHE_VERSION,
  IMAGE_PREVIEW_SETTINGS,
  imagePreviews,
} from "../src/server/image-previews.ts";

test("photo previews use lossy webp settings and a new cache generation", () => {
  assert.equal(IMAGE_PREVIEW_CACHE_VERSION, 3);
  assert.deepEqual(IMAGE_PREVIEW_SETTINGS.tiny, {
    maxSize: 48,
    quality: 45,
  });
  assert.deepEqual(IMAGE_PREVIEW_SETTINGS.thumb, {
    maxSize: 400,
    quality: 76,
  });
  assert.deepEqual(IMAGE_PREVIEW_SETTINGS.display, {
    maxSize: 1600,
    quality: 82,
  });
  assert.deepEqual(IMAGE_PREVIEW_SETTINGS.ai, {
    maxSize: 1600,
    quality: 86,
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

    const tiny = await preview(original, "tiny");
    const tinyMeta = await sharp(tiny).metadata();
    assert.equal(tinyMeta.format, "webp");
    assert.equal(tinyMeta.width, 48);
    assert.equal(tinyMeta.height, 36);
    const tinyPixels = await sharp(tiny).raw().toBuffer();
    assert.equal(tinyPixels[0], tinyPixels[1]);
    assert.equal(tinyPixels[1], tinyPixels[2]);

    const thumb = await preview(original, "thumb");
    const thumbMeta = await sharp(thumb).metadata();
    assert.equal(thumbMeta.format, "webp");
    assert.equal(thumbMeta.width, 400);
    assert.equal(thumbMeta.height, 300);

    const ai = await preview(original, "ai");
    const aiMeta = await sharp(ai).metadata();
    assert.equal(aiMeta.format, "jpeg");
    assert.equal(aiMeta.width, 1600);
    assert.equal(aiMeta.height, 1200);

    const files = await readdir(directory);
    assert.equal(files.length, 4);
    assert.ok(files.some((file) => file.endsWith("-tiny-v3.webp")));
    assert.ok(files.some((file) => file.endsWith("-display-v3.webp")));
    assert.ok(files.some((file) => file.endsWith("-thumb-v3.webp")));
    assert.ok(files.some((file) => file.endsWith("-ai-v3.jpg")));
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

test("another preview instance never reads an unfinished shared cache file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-preview-shared-"));
  const pixels = Buffer.alloc(512 * 512 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) & 255;
  const original = await sharp(pixels, {
    raw: { width: 512, height: 512, channels: 3 },
  }).png().toBuffer();
  const realWriteFile = fsPromises.writeFile;
  let pauseWrite!: () => void;
  let resumeWrite!: () => void;
  const partiallyWritten = new Promise<void>((resolve) => { pauseWrite = resolve; });
  const resumed = new Promise<void>((resolve) => { resumeWrite = resolve; });
  let intercepted = false;
  fsPromises.writeFile = (async (path, data, options) => {
    if (!intercepted && Buffer.isBuffer(data)) {
      intercepted = true;
      const middle = Math.floor(data.length / 2);
      await realWriteFile(path, data.subarray(0, middle), options);
      pauseWrite();
      await resumed;
      await appendFile(path, data.subarray(middle));
      return;
    }
    return realWriteFile(path, data, options);
  }) as typeof writeFile;
  syncBuiltinESMExports();
  let first: Promise<Buffer> | undefined;
  try {
    first = imagePreviews(directory)(original, "display");
    await partiallyWritten;
    const other = await imagePreviews(directory)(original, "display");
    const decoded = await sharp(other).raw().toBuffer();
    assert.ok(decoded.length > 0);
    resumeWrite();
    await first;
    const cached = await imagePreviews(directory)(original, "display");
    await sharp(cached).raw().toBuffer();
    assert.deepEqual((await readdir(directory)).length, 1);
  } finally {
    resumeWrite();
    await first?.catch(() => {});
    fsPromises.writeFile = realWriteFile;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupted preview publication removes its temporary file and can retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-preview-retry-"));
  const original = await sharp({ create: { width: 128, height: 128,
    channels: 3, background: "green" } }).png().toBuffer();
  const realWriteFile = fsPromises.writeFile;
  fsPromises.writeFile = (async (path, data, options) => {
    await realWriteFile(path, Buffer.from(data as Buffer).subarray(0, 4), options);
    const error = new Error("interrupted write");
    error.name = "AbortError";
    throw error;
  }) as typeof writeFile;
  syncBuiltinESMExports();
  try {
    await assert.rejects(imagePreviews(directory)(original, "thumb"), {
      name: "AbortError",
    });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    fsPromises.writeFile = realWriteFile;
    syncBuiltinESMExports();
  }
  try {
    const retried = await imagePreviews(directory)(original, "thumb");
    await sharp(retried).raw().toBuffer();
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two writer processes accept a peer's published preview if replacement is denied", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-preview-processes-"));
  const directory = join(root, "cache");
  const sourcePath = join(root, "synthetic.png");
  const pixels = Buffer.alloc(512 * 512 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 73) & 255;
  await writeFile(sourcePath, await sharp(pixels, {
    raw: { width: 512, height: 512, channels: 3 },
  }).png().toBuffer());
  const children: ChildProcess[] = [];
  const message = (child: ChildProcess, stage: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Preview writer ${stage} timed out`)); }, 15000);
    const onMessage = (value: unknown) => {
      if (!value || typeof value !== "object" || !("stage" in value)) return;
      if (value.stage !== stage && value.stage !== "failed") return;
      cleanup();
      if (value.stage === "failed") reject(new Error(String((value as { error?: unknown }).error)));
      else resolve(value as Record<string, unknown>);
    };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`Preview writer exited: ${code}`)); };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
  try {
    const fixture = fileURLToPath(new URL("./fixtures/preview-writer.mjs", import.meta.url));
    const launch = (simulateExisting: boolean) => {
      const child = fork(fixture, [directory, sourcePath, simulateExisting ? "yes" : "no"], {
        execArgv: ["--experimental-strip-types"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      return child;
    };
    const first = launch(false);
    const firstReady = message(first, "ready");
    const second = launch(true);
    await Promise.all([firstReady, message(second, "ready")]);
    const written = Promise.all([message(first, "written"), message(second, "written")]);
    first.send("start");
    second.send("start");
    await written;
    const firstDone = message(first, "done");
    first.send("publish");
    const firstResult = await firstDone;
    const file = (await readdir(directory)).find((name) => !name.startsWith("."));
    assert.ok(file);
    const handle = await open(join(directory, file), "r");
    try {
      const secondDone = message(second, "done");
      second.send("publish");
      const secondResult = await secondDone;
      assert.equal(secondResult.sha256, firstResult.sha256);
    } finally {
      await handle.close();
    }
    const cached = await fsPromises.readFile(join(directory, file));
    await sharp(cached).raw().toBuffer();
    assert.equal(createHash("sha256").update(cached).digest("hex"), firstResult.sha256);
    assert.deepEqual(await readdir(directory), [file]);
  } finally {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    }));
    await rm(root, { recursive: true, force: true });
  }
});
