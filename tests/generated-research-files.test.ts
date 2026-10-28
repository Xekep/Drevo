import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreDatabase } from "../src/server/store-database.ts";
import { openArchive } from "../src/server/database.ts";
import { aiChatStore } from "../src/server/ai-chats.ts";
import {
  generatedResearchFileStore,
  pruneGeneratedResearchFiles,
  storeGeneratedResearchFile,
  type GeneratedResearchFileMeta,
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

async function sharedFileFixture() {
  const directory = await fsPromises.mkdtemp(join(tmpdir(), "drevo-generated-identity-"));
  const chatId = randomUUID(), id = randomUUID();
  const folder = join(directory, "ai-generated-files", chatId);
  await fsPromises.mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, id), outside = join(directory, "outside-private-synthetic.pdf");
  const bytes = Buffer.from("generated-report");
  await fsPromises.writeFile(path, bytes, { mode: 0o600 });
  await fsPromises.writeFile(outside, Buffer.alloc(bytes.length, 0x58), { mode: 0o600 });
  const store = generatedResearchFileStore({ kind: "postgres" } as StoreDatabase,
    join(directory, "uploads"), {} as ReturnType<typeof aiChatStore>);
  const meta: GeneratedResearchFileMeta = { name: "report.pdf", url: `/api/ai/files/${chatId}/${id}`,
    contentType: "application/pdf", size: bytes.length, expires: Date.now() + 60_000 };
  return { directory, path, outside, bytes, store, meta, chatId, id };
}

test("shared downloads accept the original regular file and refuse an equally sized outside symlink", async t => {
  const fixture = await sharedFileFixture();
  t.after(async () => { fixture.store.close(); await fsPromises.rm(fixture.directory, { recursive: true, force: true }); });
  const read = () => fixture.store.read(fixture.chatId, fixture.id, fixture.meta);
  assert.deepEqual(await read(), fixture.bytes);
  await fsPromises.unlink(fixture.path);
  try { await fsPromises.symlink(fixture.outside, fixture.path, "file"); }
  catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) {
      t.skip("This host does not grant permission to create a test symlink"); return;
    }
    throw error;
  }
  let opens = 0;
  t.mock.method(fsPromises, "open", async () => { opens++; throw new Error("Outside target must not be opened"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await read(), null);
  assert.equal(opens, 0, "lstat rejects the symlink before opening or reading its target");
});

for (const replace of ["before-open", "after-open"] as const) {
  test(`shared download rejects an equally sized file replacement ${replace} without reading its bytes`, async t => {
    const fixture = await sharedFileFixture();
    const originalOpen = fsPromises.open;
    let bytesRead = 0, closed = false;
    t.after(async () => {
      t.mock.restoreAll(); syncBuiltinESMExports();
      fixture.store.close(); await fsPromises.rm(fixture.directory, { recursive: true, force: true });
    });
    t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
      const replaceFile = async () => {
        await fsPromises.rename(fixture.path, fixture.path + ".original");
        await fsPromises.copyFile(fixture.outside, fixture.path);
      };
      if (replace === "before-open") await replaceFile();
      const handle = await originalOpen(...args);
      if (replace === "after-open") await replaceFile();
      t.mock.method(handle, "readFile", async () => { bytesRead++; throw new Error("Unverified bytes must not be read"); });
      const close = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => { closed = true; await close(); });
      return handle;
    });
    syncBuiltinESMExports();
    assert.equal(await fixture.store.read(fixture.chatId, fixture.id, fixture.meta), null);
    assert.equal(bytesRead, 0);
    assert.equal(closed, true, "a rejected descriptor must still be closed");
  });
}
