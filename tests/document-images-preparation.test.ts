import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tiffDocumentRenderer } from "../src/server/document-images.ts";
import {
  preparationAdmission,
  PREPARATION_BYTES,
} from "../src/server/preparation-admission.ts";

test("TIFF page requests deduplicate, retain the remaining viewer and reuse a bounded cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-tiff-preparation-"));
  const path = join(directory, "page.tif");
  await sharp({
    create: { width: 20, height: 30, channels: 3, background: "white" },
  })
    .tiff()
    .toFile(path);
  const budget = preparationAdmission();
  const hold = await budget.acquire(PREPARATION_BYTES.image);
  const renderer = tiffDocumentRenderer(budget);
  const controller = new AbortController();
  try {
    const cancelled = assert.rejects(renderer(path, 0, controller.signal), {
      name: "AbortError",
    });
    const surviving = renderer(path, 0);
    for (
      let attempt = 0;
      attempt < 100 && renderer.diagnostics().viewers < 2;
      attempt++
    )
      await delay(1);
    assert.equal(renderer.diagnostics().viewers, 2);
    assert.equal(
      budget.diagnostics().queued,
      1,
      "one decode reservation for two viewers",
    );
    controller.abort();
    await cancelled;
    hold();
    const first = await surviving;
    assert.ok(first.length > 0);
    const holdAgain = await budget.acquire(PREPARATION_BYTES.image);
    try {
      assert.deepEqual(
        await renderer(path, 0),
        first,
        "cached page needs no decode slot",
      );
      assert.equal(budget.diagnostics().queued, 0);
    } finally {
      holdAgain();
    }
  } finally {
    hold();
    await renderer.close();
    budget.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TIFF shutdown cancels admission wait and drains jobs without affecting another budget owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-tiff-close-"));
  const path = join(directory, "page.tif");
  await sharp({
    create: { width: 20, height: 30, channels: 3, background: "white" },
  })
    .tiff()
    .toFile(path);
  const budget = preparationAdmission();
  const hold = await budget.acquire(PREPARATION_BYTES.image);
  const renderer = tiffDocumentRenderer(budget);
  try {
    const aborted = assert.rejects(renderer(path, 0), { name: "AbortError" });
    for (
      let attempt = 0;
      attempt < 50 && !budget.diagnostics().queued;
      attempt++
    )
      await delay(1);
    await renderer.close();
    await aborted;
    assert.equal(budget.diagnostics().queued, 0);
    assert.equal(budget.diagnostics().active, 1);
  } finally {
    hold();
    await renderer.close();
    budget.close();
    await rm(directory, { recursive: true, force: true });
  }
});
