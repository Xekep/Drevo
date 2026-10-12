import test from "node:test";
import assert from "node:assert/strict";
import {
  preparationAdmission,
  pendingAiAdmission,
} from "../src/server/preparation-admission.ts";
import { WorkQueueBusyError } from "../src/server/work-queue.ts";

test("preparation admission bounds concurrent jobs and total reserved bytes across callers", async () => {
  const budget = preparationAdmission({
    concurrent: 2,
    bytes: 96,
    maximumWaiting: 2,
    waitMs: 1000,
  });
  const first = await budget.acquire(64);
  let granted = false;
  const second = budget.acquire(64).then((release) => {
    granted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(
    granted,
    false,
    "free count capacity does not bypass the byte budget",
  );
  assert.equal(budget.diagnostics().reservedBytes, 64);
  first();
  first();
  const releaseSecond = await second;
  const third = await budget.acquire(32);
  assert.equal(budget.diagnostics().active, 2);
  assert.equal(budget.diagnostics().reservedBytes, 96);
  third();
  releaseSecond();
  assert.equal(budget.diagnostics().active, 0);
  assert.equal(budget.diagnostics().reservedBytes, 0);
  budget.close();
});

test("queued preparation cancels, expires and rejects overload without allocating a lease", async () => {
  const budget = preparationAdmission({
    concurrent: 1,
    bytes: 100,
    maximumWaiting: 2,
    waitMs: 15,
  });
  const first = await budget.acquire(80);
  const controller = new AbortController();
  const cancelled = assert.rejects(budget.acquire(10, controller.signal), {
    name: "AbortError",
  });
  const expired = assert.rejects(budget.acquire(20), WorkQueueBusyError);
  await assert.rejects(budget.acquire(1), WorkQueueBusyError);
  controller.abort();
  await cancelled;
  await expired;
  assert.equal(budget.diagnostics().queued, 0);
  assert.equal(budget.diagnostics().reservedBytes, 80);
  first();
  const active = await budget.acquire(80);
  const closed = assert.rejects(budget.acquire(10), WorkQueueBusyError);
  budget.close();
  await closed;
  active();
  await assert.rejects(budget.acquire(10), WorkQueueBusyError);
  assert.equal(budget.diagnostics().reservedBytes, 0);
});

test("heavy reservations keep FIFO ordering instead of being starved by newer small requests", async () => {
  const budget = preparationAdmission({
    concurrent: 2,
    bytes: 100,
    maximumWaiting: 2,
  });
  const release = await budget.acquire(60);
  const order: string[] = [];
  const heavy = budget.acquire(80).then((done) => {
    order.push("heavy");
    return done;
  });
  const small = budget.acquire(20).then((done) => {
    order.push("small");
    return done;
  });
  await Promise.resolve();
  assert.deepEqual(order, []);
  release();
  const finishHeavy = await heavy;
  const finishSmall = await small;
  assert.deepEqual(order, ["heavy", "small"]);
  finishHeavy();
  finishSmall();
  budget.close();
});

test("pending AI turns use an independent immediate bounded metadata budget", async () => {
  const pending = pendingAiAdmission();
  const input = preparationAdmission();
  const releases: Array<() => void> = [];
  try {
    for (let index = 0; index < 32; index++)
      releases.push(await pending.acquire(4096));
    await assert.rejects(pending.acquire(4096), WorkQueueBusyError);
    assert.equal(pending.diagnostics().queued, 0);
    const prepareImage = await input.acquire(96 * 1024 ** 2);
    prepareImage();
    assert.equal(
      input.diagnostics().active,
      0,
      "queued AI metadata does not block image preparation",
    );
  } finally {
    releases.forEach((release) => release());
    pending.close();
    input.close();
  }
});

test("shutdown rejects new and waiting preparations but drains active owners only after cleanup releases", async () => {
  const budget = preparationAdmission({ concurrent: 2, bytes: 100 });
  const first = await budget.acquire(50),
    second = await budget.acquire(50);
  const cancelled = assert.rejects(budget.acquire(10), WorkQueueBusyError);
  let drained = false;
  const drains = [budget.drain(), budget.drain()];
  void drains[0].then(() => {
    drained = true;
  });
  budget.close();
  budget.close();
  await cancelled;
  await assert.rejects(budget.acquire(1), WorkQueueBusyError);
  assert.equal(
    drained,
    false,
    "closing admission cannot close a database still used by an active owner",
  );
  first();
  first();
  await Promise.resolve();
  assert.equal(drained, false);
  second();
  await Promise.all(drains);
  assert.equal(drained, true);
  assert.equal(budget.diagnostics().reservedBytes, 0);
  await budget.drain();
});
