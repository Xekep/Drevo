import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import type pg from "pg";
import { sweepPlatformAiOrphans } from "../../src/server/platform-ai-orphan-sweep.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";

export async function verifyPlatformAiOrphanSweep(
  db: StoreDatabase,
  client: pg.Client,
  databasePath: string,
) {
  const archiveId = "inactive-ai-sweep";
  const archiveDir = join(dirname(databasePath), "archives", archiveId);
  const orphanId = randomUUID();
  const liveId = randomUUID();
  const youngId = randomUUID();
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  const files = (chatId: string) => [
    join(archiveDir, "uploads", "ai-chat-files", chatId, randomUUID()),
    join(archiveDir, "ai-generated-files", chatId, randomUUID()),
  ];
  const orphan = files(orphanId);
  const live = files(liveId);
  const young = files(youngId);
  const create = async (path: string, aged: boolean) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "private AI bytes", { mode: 0o600 });
    if (aged) {
      await utimes(path, old, old);
      await utimes(dirname(path), old, old);
    }
  };
  await client.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
  await client.query(
    "INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version) VALUES($1,'Inactive AI sweep','',false,0,18)",
    [archiveId],
  );
  try {
    // A chat with the same UUID in the root archive must not keep this other
    // archive's orphan folder alive when RLS selects archive_id.
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await client.query(
      "INSERT INTO ai_chats(archive_id,id,user_id,access_scope) VALUES('runtime-test',$1,'owner','all')",
      [orphanId],
    );
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
    await client.query(
      "INSERT INTO ai_chats(archive_id,id,user_id,access_scope) VALUES($1,$2,'owner','all')",
      [archiveId, liveId],
    );
    for (const path of [...orphan, ...live]) await create(path, true);
    for (const path of young) await create(path, false);
    const errors: Array<{ archiveId: string; error: unknown }> = [];
    await sweepPlatformAiOrphans(db, databasePath, {
      onError: (id, error) => errors.push({ archiveId: id, error }),
    });
    assert.deepEqual(orphan.map((path) => existsSync(path)), [false, false],
      "platform sweep removes old orphan bytes from an archive with no HTTP route");
    assert.deepEqual(live.map((path) => existsSync(path)), [true, true],
      "platform sweep preserves a live chat in the selected archive");
    assert.deepEqual(young.map((path) => existsSync(path)), [true, true],
      "platform sweep preserves young folders despite missing chat rows");
    assert.equal(errors.length, 0);
  } finally {
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await client.query("DELETE FROM ai_chats WHERE id=$1", [orphanId]);
    rmSync(archiveDir, { recursive: true, force: true });
  }
}
