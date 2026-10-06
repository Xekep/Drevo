import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { decodePdfPages } from "../src/server/document-pdf-decoder.ts";

const worker = new URL("./fixtures/pdf-decoder-busy.mjs", import.meta.url);
test("a stalled PDF child cannot block the parent and is killed at its deadline", async () => {
  const started = Date.now();
  const task = decodePdfPages(
    "unused",
    new AbortController().signal,
    600,
    worker,
  );
  const rejected = assert.rejects(task, /отведённое время/);
  await delay(200);
  assert.ok(
    Date.now() - started < 1500,
    "parent timer executes while child spins",
  );
  await rejected;
  assert.ok(Date.now() - started < 5000);
});
test("closing a PDF reader cancels an in-flight decoder", async () => {
  const controller = new AbortController();
  const task = decodePdfPages("unused", controller.signal, 5000, worker);
  const rejected = assert.rejects(task, /отменена/);
  await delay(200);
  controller.abort();
  await rejected;
  await assert.rejects(
    decodePdfPages("unused", controller.signal, 5000, worker),
    /отменена/,
  );
});
