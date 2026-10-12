import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openArchive } from "../src/server/database.ts";
import { mediaUsageLedger } from "../src/server/media-usage-ledger.ts";
import { recordMediaOriginal } from "../src/server/media-originals.ts";
import { uploadQuota, UploadQuotaError } from "../src/server/upload-quota.ts";
import { workQueue } from "../src/server/work-queue.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "drevo-ledger-"));
  const archive = await openArchive(":memory:", {
    title: "",
    description: "",
    demo: false,
    people: [],
  });
  const ledger = mediaUsageLedger(archive.db, directory, { periodMs: 0 });
  const close = async () => {
    await ledger.close();
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, archive, ledger, close };
}

test("original usage counts distinct records and rolls back together with metadata", async () => {
  const f = await fixture();
  try {
    const db = f.archive.db;
    await recordMediaOriginal(db, "/media/a.jpg", 100, "owner");
    await recordMediaOriginal(db, "/media/a.jpg", 300, "other");
    assert.deepEqual(await f.ledger.read(), { files: 1, bytes: 100 });
    await assert.rejects(
      db.transaction(async () => {
        await recordMediaOriginal(db, "/media/b.jpg", 200, "owner");
        await db
          .prepare(
            "UPDATE media_originals SET size_bytes=500 WHERE url='/media/a.jpg'",
          )
          .run();
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.deepEqual(await f.ledger.read(), { files: 1, bytes: 100 });
    await db
      .prepare(
        "UPDATE media_originals SET size_bytes=150 WHERE url='/media/a.jpg'",
      )
      .run();
    assert.deepEqual(await f.ledger.read(), { files: 1, bytes: 150 });
    await db
      .prepare("DELETE FROM media_originals WHERE url='/media/a.jpg'")
      .run();
    assert.deepEqual(await f.ledger.read(), { files: 0, bytes: 0 });
  } finally {
    await f.close();
  }
});

test("private reconciliation backfills only references, preserves provenance and excludes document duplicates", async () => {
  const f = await fixture();
  try {
    const db = f.archive.db;
    await writeFile(join(f.directory, "portrait.jpg"), Buffer.alloc(100));
    await writeFile(join(f.directory, "someone-else.jpg"), Buffer.alloc(500));
    await writeFile(join(f.directory, "citation.pdf"), Buffer.alloc(200));
    await db.prepare("INSERT INTO people(id,data) VALUES('p',?)").run(
      JSON.stringify({
        id: "p",
        photo: "/media/portrait.jpg",
        sources: [{ url: "/media/citation.pdf#page=2" }],
      }),
    );
    await f.ledger.ensure();
    assert.deepEqual(await f.ledger.read(), { files: 2, bytes: 300 });
    assert.equal(
      await db
        .prepare(
          "SELECT 1 FROM media_originals WHERE url='/media/someone-else.jpg'",
        )
        .get(),
      undefined,
    );
    await db
      .prepare(
        "UPDATE media_originals SET uploaded_by='owner' WHERE url='/media/portrait.jpg'",
      )
      .run();
    await writeFile(join(f.directory, "portrait.jpg"), Buffer.alloc(150));
    await f.ledger.reconcile();
    assert.equal(
      (await db
        .prepare(
          "SELECT uploaded_by FROM media_originals WHERE url='/media/portrait.jpg'",
        )
        .get())!.uploaded_by,
      "owner",
    );
    assert.deepEqual(await f.ledger.read(), { files: 2, bytes: 350 });
    await db
      .prepare(
        "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES('d','d','d','citation.pdf',200,'owner','now')",
      )
      .run();
    assert.deepEqual(await f.ledger.read(), { files: 1, bytes: 150 });
  } finally {
    await f.close();
  }
});

test("missing live originals keep quota; unreferenced missing originals release it", async () => {
  const f = await fixture();
  try {
    const db = f.archive.db;
    await writeFile(join(f.directory, "a.jpg"), Buffer.alloc(100));
    await db
      .prepare("INSERT INTO people(id,data) VALUES('p',?)")
      .run(JSON.stringify({ id: "p", photo: "/media/a.jpg" }));
    await f.ledger.ensure();
    await unlink(join(f.directory, "a.jpg"));
    await f.ledger.reconcile();
    assert.deepEqual(await f.ledger.read(), { files: 1, bytes: 100 });
    await db.prepare("UPDATE people SET data='{}' WHERE id='p'").run();
    await f.ledger.reconcile();
    assert.deepEqual(await f.ledger.read(), { files: 0, bytes: 0 });
  } finally {
    await f.close();
  }
});

test("quota reconciles outside transactions and never scans files under the reservation lock", async () => {
  const f = await fixture();
  try {
    const db = f.archive.db;
    await db
      .prepare(
        "INSERT INTO users(id,name,role,approved) VALUES('admin','Admin','admin',1)",
      )
      .run();
    await recordMediaOriginal(db, "/media/a.jpg", 500, "admin");
    await writeFile(join(f.directory, "a.jpg"), Buffer.alloc(500));
    const ledger = {
      ...f.ledger,
      async ensure() {
        assert.equal(db.inTransaction(), false);
        await f.ledger.ensure();
      },
    };
    const quota = uploadQuota(db, {
      bytes: 1000,
      freeReserve: 0,
      mediaUsage: ledger,
    });
    const forbiddenScan = async () => {
      throw new Error("filesystem scan under lock");
    };
    const outcomes = await Promise.allSettled([
      quota.acquire("admin", 400, 10000, forbiddenScan),
      quota.acquire("admin", 400, 10000, forbiddenScan),
    ]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    const denied = outcomes.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    assert.ok(denied.reason instanceof UploadQuotaError);
    assert.equal(denied.reason.status, 507);
    for (const result of outcomes)
      if (result.status === "fulfilled") await result.value();
    assert.deepEqual(await f.ledger.read(), { files: 1, bytes: 500 });
  } finally {
    await f.close();
  }
});

test("queued reconciliation allocates no SQL inventory and closing one ledger preserves the shared queue", async () => {
  const f = await fixture();
  const queue = workQueue(1, 2, 1000);
  const release = await queue.acquire();
  let queries = 0;
  const db = {
    ...f.archive.db,
    prepare: (...args: Parameters<typeof f.archive.db.prepare>) => {
      queries++;
      return f.archive.db.prepare(...args);
    },
  };
  const ledger = mediaUsageLedger(db, f.directory, {
    periodMs: 0,
    executionQueue: queue,
  });
  try {
    const scan = ledger.reconcile();
    const cancelled = assert.rejects(scan, { name: "AbortError" });
    await Promise.resolve();
    assert.equal(queries, 0);
    assert.equal(queue.diagnostics().queued, 1);
    await ledger.close();
    await cancelled;
    release();
    const next = await queue.acquire();
    next();
  } finally {
    release();
    queue.close();
    await ledger.close();
    await f.close();
  }
});
