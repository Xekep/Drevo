import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { imagePreviews } from "../../src/server/image-previews.ts";
import { workQueue } from "../../src/server/work-queue.ts";

const directory = await mkdtemp(join(tmpdir(), "drevo-preview-benchmark-"));
try {
  let seed = 12345;
  const pixels = Buffer.alloc(1600 * 1200 * 3);
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const image = await sharp(pixels, {
    raw: { width: 1600, height: 1200, channels: 3 },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  const path = join(directory, "synthetic.jpg");
  await writeFile(path, image);
  for (const concurrency of [1, 2]) {
    const queue = workQueue(concurrency, 32, 60_000);
    const preview = imagePreviews(join(directory, String(concurrency)), queue);
    const started = performance.now();
    const outputs = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        preview({ path, cacheKey: `cold-${i}` }, "thumb"),
      ),
    );
    const coldMs = performance.now() - started;
    const warmStarted = performance.now();
    await Promise.all(
      Array.from({ length: 100 }, () =>
        preview({ path, cacheKey: "cold-0" }, "thumb"),
      ),
    );
    console.log(
      JSON.stringify({
        concurrency,
        distinctCold: 24,
        coldMs,
        repeatedCached: 100,
        cachedMs: performance.now() - warmStarted,
        outputHash: createHash("sha256")
          .update(Buffer.concat(outputs))
          .digest("hex"),
        queue: queue.diagnostics(),
      }),
    );
    queue.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
