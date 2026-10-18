import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { openArchive } from "../src/server/database.ts";
import { aiChatStore } from "../src/server/ai-chats.ts";
import {
  generatedResearchFileStore,
  pruneGeneratedResearchFiles,
  storeGeneratedResearchFile,
} from "../src/server/generated-research-files.ts";
import type { GeneratedResearchFile } from "../src/server/code-interpreter.ts";

const file = (bytes: number, expires: number): GeneratedResearchFile => ({
  ownerId: "owner",
  chatId: "chat",
  contentType: "application/pdf",
  name: "report.pdf",
  bytes: Buffer.alloc(bytes),
  expires,
});

test("local generated downloads keep metadata and bytes for the same lifetime", async () => {
  const archive = await openArchive(
    ":memory:",
    JSON.parse(
      readFileSync(new URL("./fixtures/family.json", import.meta.url), "utf8"),
    ),
  );
  const store = generatedResearchFileStore(
    archive.db,
    "unused-uploads",
    aiChatStore(archive.db),
  );
  try {
    const chatId = randomUUID(),
      expires = Date.now() + 60_000;
    const link = await store.save({ ...file(8, expires), chatId });
    assert.ok(link);
    const id = link.url.split("/").at(-1)!;
    assert.equal(store.local(id)?.bytes.length, 8);
    assert.deepEqual(store.metadata([link]), [
      { ...link, contentType: "application/pdf", size: 8, expires },
    ]);
    assert.deepEqual(store.metadata([{ ...link, url: `/other/${id}` }]), []);
    await store.prune(expires);
    assert.equal(store.local(id), undefined);
    assert.deepEqual(store.metadata([link]), []);
    const next = await store.save({ ...file(8, Date.now() + 60_000), chatId });
    assert.ok(next);
    await store.deleteChat(chatId);
    assert.deepEqual(store.metadata([next]), []);
    assert.equal(store.local(next.url.split("/").at(-1)!), undefined);
  } finally {
    store.close();
    await archive.close();
  }
});

test("PDF and calculation files share the same bounded cache", () => {
  const files = new Map<string, GeneratedResearchFile>();
  const first = storeGeneratedResearchFile(files, file(6, 200), 100, 8);
  assert.ok(first);
  assert.equal(storeGeneratedResearchFile(files, file(3, 200), 100, 8), null);
  assert.equal(files.size, 1);
  assert.ok(storeGeneratedResearchFile(files, file(2, 200), 100, 8));
  assert.equal(files.size, 2);
  assert.ok(storeGeneratedResearchFile(files, file(8, 300), 200, 8));
  assert.equal(files.size, 1, "expired files release their budget");
  pruneGeneratedResearchFiles(files, 300);
  assert.equal(
    files.size,
    0,
    "expired files leave memory without another upload",
  );
});
