import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import {
  imagePreviews,
  ImagePreviewBusyError,
} from "../src/server/image-previews.ts";
import {
  preparationAdmission,
  PREPARATION_BYTES,
} from "../src/server/preparation-admission.ts";
import { workQueue } from "../src/server/work-queue.ts";

test("preview cache bypasses CPU admission and saturated admission never reads an unavailable original", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-preview-budget-"));
  const path = join(directory, "original.png");
  const budget = preparationAdmission({ maximumWaiting: 0 });
  const previews = imagePreviews(join(directory, "cache"), undefined, budget);
  let hold: (() => void) | undefined;
  try {
    await writeFile(
      path,
      await sharp({
        create: { width: 20, height: 20, channels: 3, background: "white" },
      })
        .png()
        .toBuffer(),
    );
    const cached = await previews({ path, cacheKey: "present" }, "thumb");
    hold = await budget.acquire(PREPARATION_BYTES.image);
    assert.deepEqual(
      await previews({ path, cacheKey: "present" }, "thumb"),
      cached,
    );
    await assert.rejects(
      previews(
        { path: join(directory, "does-not-exist.png"), cacheKey: "missing" },
        "thumb",
      ),
      ImagePreviewBusyError,
      "admission failure must happen before touching the original, and cannot fall back to a download",
    );
  } finally {
    hold?.();
    await previews.close();
    budget.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("preview shutdown cancels its queued memory wait without closing borrowed process resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-preview-close-"));
  const budget = preparationAdmission();
  const queue = workQueue(2, 32);
  const hold = await budget.acquire(PREPARATION_BYTES.image);
  const previews = imagePreviews(join(directory, "cache"), queue, budget);
  try {
    const aborted = assert.rejects(
      previews(
        { path: join(directory, "not-read.png"), cacheKey: "waiting" },
        "thumb",
      ),
      { name: "AbortError" },
    );
    for (let index = 0; index < 100 && !budget.diagnostics().queued; index++)
      await delay(1);
    assert.equal(budget.diagnostics().queued, 1);
    await previews.close();
    await aborted;
    assert.equal(budget.diagnostics().queued, 0);
    assert.equal(budget.diagnostics().active, 1);
    const other = await queue.acquire();
    other();
  } finally {
    hold();
    await previews.close();
    queue.close();
    budget.close();
    await rm(directory, { recursive: true, force: true });
  }
});
