import assert from "node:assert/strict";
import test from "node:test";
import { workQueue, WorkQueueBusyError } from "../src/server/work-queue.ts";

test("bounded FIFO frees slots on abort, rejects overload and never double releases", async () => {
  const queue = workQueue(2, 2, 1000);
  const first = await queue.acquire(),
    second = await queue.acquire();
  const abort = new AbortController();
  const cancelled = queue.acquire(abort.signal);
  const last = queue.acquire();
  await assert.rejects(queue.acquire(), WorkQueueBusyError);
  abort.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  first();
  first();
  const third = await last;
  assert.deepEqual(queue.diagnostics(), {
    active: 2,
    queued: 0,
    concurrency: 2,
    maximumWaiting: 2,
  });
  second();
  third();
  assert.equal(queue.diagnostics().active, 0);
});

test("timeout and shutdown remove waiting jobs without consuming a slot", async () => {
  const queue = workQueue(1, 2, 10);
  const release = await queue.acquire();
  await assert.rejects(queue.acquire(), WorkQueueBusyError);
  assert.equal(queue.diagnostics().queued, 0);
  const pending = queue.acquire();
  queue.close();
  await assert.rejects(pending, WorkQueueBusyError);
  await assert.rejects(queue.acquire(), WorkQueueBusyError);
  release();
  assert.equal(queue.diagnostics().active, 0);
});
