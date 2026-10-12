import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import { uploadQuota } from "../src/server/upload-quota.ts";
import type { MediaUsageLedger } from "../src/server/media-usage-ledger.ts";

test("cancelled reconciliation waiter creates no upload reservation and keeps shared initialization alive", async () => {
  const archive = await openArchive(":memory:", {
    title: "Synthetic",
    description: "",
    demo: false,
    people: [],
  });
  await archive.db
    .prepare(
      "INSERT INTO users(id,name,role,approved) VALUES('owner','Owner','admin',1)",
    )
    .run();
  let finish: () => void = () => {};
  const initialization = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let initialized = false;
  let calls = 0;
  const ledger = {
    ensure: async () => {
      calls++;
      assert.equal(archive.db.inTransaction(), false);
      await initialization;
      initialized = true;
    },
    read: async () => ({ files: 0, bytes: 0 }),
    reconcile: async () => ({ files: 0, bytes: 0 }),
    close: async () => {},
  } as MediaUsageLedger;
  const quota = uploadQuota(archive.db, { mediaUsage: ledger, freeReserve: 0 });
  const controller = new AbortController();
  const cancelled = assert.rejects(
    quota.acquire(
      "owner",
      10,
      10000,
      async () => {
        throw new Error("no scan");
      },
      controller.signal,
    ),
    { name: "AbortError" },
  );
  const other = quota.acquire("owner", 10, 10000);
  controller.abort();
  try {
    await cancelled;
    assert.equal(initialized, false);
    assert.equal(
      (await archive.db
        .prepare("SELECT count(*) AS n FROM document_upload_requests")
        .get())!.n,
      0,
    );
    finish();
    const release = await other;
    assert.equal(initialized, true);
    assert.equal(calls, 2);
    assert.equal(
      (await archive.db
        .prepare("SELECT count(*) AS n FROM document_upload_requests")
        .get())!.n,
      1,
    );
    await release();
  } finally {
    finish();
    await other.then(
      (release) => release(),
      () => {},
    );
    await archive.close();
  }
});
