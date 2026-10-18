import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { aiChatStore } from "../../src/server/ai-chats.ts";
import { generatedResearchFileStore } from "../../src/server/generated-research-files.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";

export async function verifyGeneratedFileCache(
  store: ReturnType<typeof generatedResearchFileStore>,
  db: StoreDatabase,
  uploads: string,
  chatId: string,
  link: { name: string; url: string },
  bytes: Buffer,
) {
  const id = link.url.split("/").at(-1)!;
  const metadata = store.metadata([link]);
  assert.equal(
    store.local(id),
    undefined,
    "shared files must not retain download buffers in the local cache",
  );
  assert.deepEqual(metadata, [
    {
      ...link,
      contentType: "application/pdf",
      size: bytes.length,
      expires: metadata[0]?.expires,
    },
  ]);
  assert.deepEqual(
    store.metadata([{ ...link, url: link.url.replace(chatId, randomUUID()) }]),
    [],
    "metadata must match the whole issued URL, not just its final file ID",
  );
  const reader = generatedResearchFileStore(db, uploads, aiChatStore(db));
  try {
    assert.deepEqual(
      await reader.read(chatId, id, metadata[0]),
      bytes,
      "a fresh store reads the shared file without a process-local byte cache",
    );
  } finally {
    reader.close();
  }
  return metadata;
}
