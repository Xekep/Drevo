import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  pdfDecodeCoordinator,
  PdfDecodeBusyError,
} from "../src/server/pdf-decode-coordinator.ts";
import type { decodePdfPages } from "../src/server/document-pdf-decoder.ts";

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
