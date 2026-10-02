import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aiChatStore } from "../../src/server/ai-chats.ts";
import { generatedResearchFileStore } from "../../src/server/generated-research-files.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";

const MiB = 1024 * 1024;

export async function verifyGeneratedFileGlobalCap(db: StoreDatabase, source: string) {
  assert.equal(db.kind, "postgres");
  const chats = aiChatStore(db);
  const store = generatedResearchFileStore(db, join(dirname(source), "uploads"), chats);
  const contenders = await Promise.all([0, 1].map(() =>
    chats.create("owner", JSON.stringify(["admin", "all", ""]))));
  const workers = contenders.map((chat) => {
    const child = fork(join(import.meta.dirname, "generated-file-cap-worker.ts"),
      [source, chat.id], { execArgv: ["--experimental-strip-types"],
        env: { ...process.env, DATABASE_BACKEND: "postgres", ARCHIVE_ID: db.archiveId },
        stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stderr?.pipe(process.stderr);
    const ready = new Promise<void>((resolve, reject) => {
      child.once("message", (message) => {
        if ((message as { ready?: boolean })?.ready) resolve();
        else reject(new Error("Generated-file worker did not become ready"));
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Generated-file worker exited early: ${code}`)));
    });
    return { child, ready };
  });
  try {
    await Promise.all(workers.map((worker) => worker.ready));
    const results = await Promise.all(workers.map(({ child }) => new Promise<{
      saved: boolean; url?: string; error?: string;
    }>((resolve, reject) => {
      child.once("message", (message) => resolve(message as { saved: boolean; url?: string; error?: string }));
      child.once("error", reject);
      child.send("start");
    })));
    assert.deepEqual(results.map((result) => result.error), [undefined, undefined]);
    assert.equal(results.filter((result) => result.saved).length, 1,
      "two backend processes must admit only one 34 MiB file under the 64 MiB cap");
    const winnerIndex = results.findIndex((result) => result.saved);
    const winner = contenders[winnerIndex];
    const winnerPath = join(dirname(source), "ai-generated-files", winner.id,
      results[winnerIndex].url!.split("/").at(-1)!);
    assert.equal(statSync(winnerPath).size, 34 * MiB);

    // A physically retained file without committed chat metadata still uses budget.
    const foreignRoot = join(dirname(source), "archives", "cap-neighbor",
      "ai-generated-files", randomUUID());
    mkdirSync(foreignRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(foreignRoot, "unknown-name"), Buffer.alloc(29 * MiB));
    const replacement = await chats.create("owner", JSON.stringify(["admin", "all", ""]));
    const smallFile = { ownerId: "owner", chatId: replacement.id, name: "small.pdf",
      contentType: "application/pdf", bytes: Buffer.alloc(2 * MiB),
      expires: Date.now() + 30 * 60_000 };
    assert.equal(await store.save(smallFile), null,
      "unknown files in another archive also count against the platform cap");
    rmSync(join(dirname(source), "archives", "cap-neighbor"), { recursive: true });
    const staleRoot = join(dirname(source), "archives", "cap-neighbor",
      "ai-generated-files", randomUUID());
    mkdirSync(staleRoot, { recursive: true, mode: 0o700 });
    const stalePath = join(staleRoot, randomUUID());
    writeFileSync(stalePath, Buffer.alloc(29 * MiB));
    const oldTime = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(stalePath, oldTime, oldTime);
    assert.ok(await store.save(smallFile),
      "admission reclaims expired physical files in an inactive archive");
    assert.equal(existsSync(stalePath), false);
    await store.deleteChat(replacement.id);
    rmSync(join(dirname(source), "archives", "cap-neighbor"), { recursive: true });
    const unsafeEntry = join(dirname(source), "ai-generated-files", randomUUID());
    symlinkSync(source, unsafeEntry);
    await assert.rejects(store.save(smallFile), /Unsafe generated-file entry/,
      "a symlink inside temporary storage must fail closed");
    unlinkSync(unsafeEntry);

    // Simulate a crashed writer: remove its chat row without touching the bytes.
    await chats.delete(winner.id, "owner");
    const afterCrash = { ...smallFile, bytes: Buffer.alloc(34 * MiB) };
    const [, racingSave] = await Promise.all([store.prune(), store.save(afterCrash)]);
    assert.equal(existsSync(winnerPath), false,
      "prune and creation cannot leave bytes from the deleted chat behind");
    const installed = racingSave || await store.save(afterCrash);
    assert.ok(installed, "after physical cleanup a 34 MiB replacement fits");
    await store.deleteChat(replacement.id);
    await chats.delete(replacement.id, "owner");
    assert.equal(existsSync(join(dirname(source), "ai-generated-files", replacement.id)), false);
    await chats.delete(contenders[1 - winnerIndex].id, "owner");
    await store.prune();
  } finally {
    for (const { child } of workers) if (!child.killed) child.kill();
    store.close();
  }
}
