import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import {
  AccountAttachmentExportMissing,
  AccountAttachmentExportTooLarge,
  MAX_ACCOUNT_ATTACHMENT_FILES,
  prepareAccountAttachmentExport,
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
