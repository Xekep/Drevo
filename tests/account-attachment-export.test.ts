import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { openPromise } from "yauzl";
import {
  AccountAttachmentExportMissing,
  AccountAttachmentExportTooLarge,
  MAX_ACCOUNT_ATTACHMENT_FILES,
  aiFilesFromJson,
  prepareAccountAttachmentExport,
  type OwnAiAttachment,
  type OwnCommentAttachment,
} from "../src/server/account-attachment-export.ts";

test("account attachment ZIP rejects a swapped symlink before streaming its target bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-own-attachments-"));
  try {
    const uploads = join(root, "uploads");
    const fileRoot = join(uploads, "discussion-files");
    await mkdir(fileRoot, { recursive: true });
    const id = randomUUID();
    const original = join(fileRoot, id);
    const bytes = Buffer.from("authorized-original-data");
    await writeFile(original, bytes);
    const file: OwnCommentAttachment = {
      archiveId: "tree-a", personId: "person-a", commentId: "1",
      file: { id, name: "note.txt", type: "text/plain", size: bytes.length },
    };
    const bundle = await prepareAccountAttachmentExport([file], () => uploads);
    const secret = join(root, "outside-secret");
    const secretBytes = Buffer.alloc(bytes.length, 0x53);
    await writeFile(secret, secretBytes);
    await rm(original);
    await symlink(secret, original, "file");
    const chunks: Buffer[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    await assert.rejects(bundle.writeTo(destination), AccountAttachmentExportMissing);
    assert.equal(Buffer.concat(chunks).includes(secretBytes), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("account attachment bundle rejects an excessive file count before reading originals", async () => {
  const item: OwnCommentAttachment = {
    archiveId: "tree-a", personId: "person-a", commentId: "1",
    file: { id: randomUUID(), name: "note.txt", type: "text/plain", size: 1 },
  };
  await assert.rejects(
    prepareAccountAttachmentExport(Array(MAX_ACCOUNT_ATTACHMENT_FILES + 1).fill(item), () => "missing"),
    AccountAttachmentExportTooLarge,
  );
});

test("account attachment ZIP keeps an AI original linked to its visible message", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-own-ai-attachments-"));
  try {
    const uploads = join(root, "uploads");
    const chatId = randomUUID();
    const id = randomUUID();
    const bytes = Buffer.from("research-original");
    const folder = join(uploads, "ai-chat-files", chatId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, id), bytes);
    const file = { name: "research.txt", type: "text/plain", size: bytes.length,
      url: `/api/ai/attachments/${chatId}/${id}` };
    const attachment: OwnAiAttachment = {
      archiveId: "tree-a", chatId, messageId: "42", accessScope: "current", file,
    };
    assert.deepEqual(aiFilesFromJson([file], chatId), [file]);
    assert.deepEqual(aiFilesFromJson(JSON.stringify([file]), chatId), [file]);
    const bundle = await prepareAccountAttachmentExport([attachment], () => uploads);
    const chunks: Buffer[] = [];
    await bundle.writeTo(new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    }));
    const path = join(root, "account.zip");
    await writeFile(path, Buffer.concat(chunks));
    const zip = await openPromise(path);
    const entries = new Map<string, Buffer>();
    for await (const entry of zip.eachEntry()) {
      const parts: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry))
        parts.push(Buffer.from(chunk));
      entries.set(entry.fileName, Buffer.concat(parts));
    }
    const manifest = JSON.parse(entries.get("manifest.json")!.toString());
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.attachments[0].kind, "ai");
    assert.equal(manifest.attachments[0].chatId, chatId);
    assert.equal(manifest.attachments[0].messageId, "42");
    assert.deepEqual(entries.get(manifest.attachments[0].path), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
