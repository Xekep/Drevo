import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  pdfDecodeCoordinator,
  PdfDecodeBusyError,
} from "../src/server/pdf-decode-coordinator.ts";
import type { decodePdfPages } from "../src/server/document-pdf-decoder.ts";
import {
  preparationAdmission,
  PREPARATION_BYTES,
} from "../src/server/preparation-admission.ts";

test("different archive callers share one PDF process budget and queued requests expire", async () => {
  let running = 0,
    maximum = 0;
  const decoder: typeof decodePdfPages = async () => {
    running++;
    maximum = Math.max(maximum, running);
    await delay(150);
    running--;
    return [{ width: 100, height: 200 }];
  };
  const coordinator = pdfDecodeCoordinator(decoder, 50);
  try {
    const first = coordinator.decode(
      "archive-a.pdf",
      new AbortController().signal,
    );
    const second = coordinator.decode(
      "archive-b.pdf",
      new AbortController().signal,
    );
    const expired = assert.rejects(second, PdfDecodeBusyError);
    await Promise.all([first, expired]);
    assert.equal(maximum, 1);
    assert.deepEqual(coordinator.diagnostics(), { active: 0, queued: 0 });
    await coordinator.decode("archive-b.pdf", new AbortController().signal);
  } finally {
    await coordinator.close();
  }
});
test("shutdown cancels the active decoder and rejects waiting archive tasks", async () => {
  const decoder: typeof decodePdfPages = async (_path, signal) => {
    await delay(5000, undefined, { signal });
    return [{ width: 100, height: 200 }];
  };
  const coordinator = pdfDecodeCoordinator(decoder);
  const first = assert.rejects(
    coordinator.decode("active.pdf", new AbortController().signal),
    { name: "AbortError" },
  );
  const waiting = assert.rejects(
    coordinator.decode("waiting.pdf", new AbortController().signal),
    /отменена/,
  );
  await coordinator.close();
  await Promise.all([first, waiting]);
  await assert.rejects(
    coordinator.decode("after-close.pdf", new AbortController().signal),
    /отменена/,
  );
});

test("PDF acquires shared memory admission before starting a child decoder and cancellation frees the wait", async () => {
  const budget = preparationAdmission();
  const releaseUpload = await budget.acquire(PREPARATION_BYTES.image);
  let decodes = 0;
  const decoder: typeof decodePdfPages = async () => {
    decodes++;
    return [{ width: 100, height: 200 }];
  };
  const coordinator = pdfDecodeCoordinator(decoder, 5000, budget);
  const controller = new AbortController();
  const cancelled = assert.rejects(
    coordinator.decode("waiting.pdf", controller.signal),
    { name: "AbortError" },
  );
  await delay(1);
  assert.equal(decodes, 0);
  assert.equal(budget.diagnostics().queued, 1);
  controller.abort();
  await cancelled;
  assert.equal(budget.diagnostics().queued, 0);
  releaseUpload();
  await coordinator.decode("available.pdf", new AbortController().signal);
  assert.equal(decodes, 1);
  assert.equal(budget.diagnostics().reservedBytes, 0);
  await coordinator.close();
  budget.close();
});
