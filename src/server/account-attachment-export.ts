import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import type { PoolClient } from "pg";
import { commentFileId, type CommentAttachmentFile } from "../shared/person-discussion.ts";
import { commentFilesFromJson } from "./discussion-attachments.ts";

const MAX_FILES = 50_000;
const MAX_BYTES = 12 * 1024 * 1024 * 1024;
const archiveIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;

export class AccountAttachmentExportTooLarge extends Error {}
export class AccountAttachmentExportMissing extends Error {}

export type OwnCommentAttachment = {
  archiveId: string;
  personId: string;
  commentId: string;
  file: CommentAttachmentFile;
};

/** Run under the same transaction that holds the session and membership
 * locks through ZIP delivery. Comment edits/deletes cannot detach an original
 * after this row check and before its bytes are streamed. */
export async function ownAttachmentsStillCurrent(
  client: PoolClient,
  accountId: string,
  attachments: OwnCommentAttachment[],
) {
  const byArchive = new Map<string, OwnCommentAttachment[]>();
  for (const attachment of attachments) {
    const list = byArchive.get(attachment.archiveId) || [];
    list.push(attachment);
    byArchive.set(attachment.archiveId, list);
  }
  for (const [archiveId, files] of byArchive) {
    await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
    const ids = [...new Set(files.map((file) => file.commentId))];
    const rows = await client.query(
      `SELECT id,person_id,author_id,attachments FROM person_comments
       WHERE id=ANY($1::bigint[]) FOR SHARE NOWAIT`,
      [ids],
    );
    const current = new Map(rows.rows.map((row) => [String(row.id), row]));
    for (const attachment of files) {
      const row = current.get(attachment.commentId);
      if (!row || row.author_id !== accountId ||
          row.person_id !== attachment.personId ||
          !commentFilesFromJson(row.attachments).some((file) =>
            file.id === attachment.file.id && file.name === attachment.file.name &&
            file.type === attachment.file.type && file.size === attachment.file.size))
        return false;
    }
  }
  return true;
}

type PreparedFile = OwnCommentAttachment & {
  path: string;
  source: string;
  sha256: string;
};

async function hashOriginal(source: string, expectedSize: number) {
  let info;
  try {
    info = await lstat(source);
  } catch {
    throw new AccountAttachmentExportMissing("Discussion original is missing");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedSize)
    throw new AccountAttachmentExportMissing("Discussion original changed");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(source)) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      hash.update(buffer);
    }
  } catch {
    throw new AccountAttachmentExportMissing("Discussion original is unreadable");
  }
  if (bytes !== expectedSize)
    throw new AccountAttachmentExportMissing("Discussion original changed");
  return hash.digest("hex");
}

/** Prepare an account-only bundle without retaining file contents in memory.
 * Names are metadata in the manifest; ZIP entry paths use generated indexes
 * and validated UUIDs, so an uploaded name cannot become a path. */
export async function prepareAccountAttachmentExport(
  attachments: OwnCommentAttachment[],
  uploadsForArchive: (archiveId: string) => string,
) {
  if (attachments.length > MAX_FILES)
    throw new AccountAttachmentExportTooLarge("Too many discussion originals");
  const total = attachments.reduce((sum, attachment) => sum + attachment.file.size, 0);
  if (!Number.isSafeInteger(total) || total > MAX_BYTES)
    throw new AccountAttachmentExportTooLarge("Discussion originals exceed export limit");
  const files: PreparedFile[] = [];
  for (const attachment of attachments) {
    if (!archiveIdPattern.test(attachment.archiveId) ||
        !commentFileId.test(attachment.file.id))
      throw new AccountAttachmentExportMissing("Invalid discussion original ID");
    const source = join(uploadsForArchive(attachment.archiveId),
      "discussion-files", attachment.file.id);
    const sha256 = await hashOriginal(source, attachment.file.size);
    files.push({
      ...attachment,
      source,
      sha256,
      path: `files/${files.length + 1}-${attachment.file.id}`,
    });
  }
  const manifest = {
    format: "drevo-account-attachments",
    version: 1,
    exportedAt: new Date().toISOString(),
    attachments: files.map(({ archiveId, personId, commentId, file, path, sha256 }) => ({
      archiveId,
      personId,
      commentId,
      path,
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      sha256,
    })),
  };
  const manifestData = Buffer.from(JSON.stringify(manifest));
  if (manifestData.length > 24 * 1024 * 1024)
    throw new AccountAttachmentExportTooLarge("Discussion manifest exceeds export limit");
  return {
    async writeTo(destination: Writable) {
      const zip = new ZipFile();
      const output = pipeline(zip.outputStream, destination);
      void output.catch(() => {});
      zip.on("error", (error) => (zip.outputStream as Readable).destroy(error));
      try {
        zip.addBuffer(manifestData, "manifest.json");
        for (const file of files) {
          zip.addReadStreamLazy(file.path, { compress: false, size: file.file.size },
            (callback) => {
              const source = createReadStream(file.source);
              const hash = createHash("sha256");
              const checked = new Transform({
                transform(chunk: Buffer, _encoding, done) {
                  hash.update(chunk);
                  done(null, chunk);
                },
                flush(done) {
                  done(hash.digest("hex") === file.sha256
                    ? undefined
                    : new AccountAttachmentExportMissing("Discussion original changed during export"));
                },
              });
              source.on("error", (error) => checked.destroy(error));
              checked.on("error", (error) => {
                source.destroy();
                zip.emit("error", error);
              });
              callback(null, source.pipe(checked));
            });
        }
        zip.end();
        await output;
      } catch (error) {
        (zip.outputStream as Readable).destroy(error as Error);
        await output.catch(() => {});
        throw error;
      }
    },
  };
}
