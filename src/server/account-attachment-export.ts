import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import type { PoolClient } from "pg";
import { commentFileId, type CommentAttachmentFile } from "../shared/person-discussion.ts";
import type { ResearchAttachment } from "../shared/research-attachments.ts";
import { commentFilesFromJson } from "./discussion-attachments.ts";

// Keep a single account download bounded while it holds database locks.
export const MAX_ACCOUNT_ATTACHMENT_FILES = 1_000;
export const MAX_ACCOUNT_ATTACHMENT_BYTES = 256 * 1024 * 1024;
const archiveIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const aiFileUrl = /^\/api\/ai\/attachments\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/i;
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export class AccountAttachmentExportTooLarge extends Error {}
export class AccountAttachmentExportMissing extends Error {}

function streamOriginalError(error: unknown): Error {
  if (error instanceof AccountAttachmentExportMissing) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" ||
      code === "EACCES" || code === "EPERM")
    return new AccountAttachmentExportMissing("Discussion original changed during export");
  return error instanceof Error ? error : new Error(String(error));
}

export type OwnCommentAttachment = {
  archiveId: string;
  personId: string;
  commentId: string;
  file: CommentAttachmentFile;
};
export type OwnAiAttachment = {
  archiveId: string;
  chatId: string;
  messageId: string;
  accessScope: string;
  file: ResearchAttachment;
};

export function aiFilesFromJson(value: unknown, chatId: string): ResearchAttachment[] {
  try {
    if (typeof value === "string") value = JSON.parse(value);
  } catch {
    throw new AccountAttachmentExportMissing("Invalid AI attachment metadata");
  }
  if (!Array.isArray(value) || value.length > 3)
    throw new AccountAttachmentExportMissing("Invalid AI attachment metadata");
  return value.map((item) => {
    if (!item || typeof item !== "object")
      throw new AccountAttachmentExportMissing("Invalid AI attachment metadata");
    const file = item as Record<string, unknown>;
    const match = typeof file.url === "string" ? aiFileUrl.exec(file.url) : null;
    if (!match || match[1] !== chatId ||
        typeof file.name !== "string" || file.name.length > 255 ||
        typeof file.type !== "string" || file.type.length > 128 ||
        typeof file.size !== "number" || !Number.isSafeInteger(file.size) ||
        file.size < 1 || file.size > 5 * 1024 * 1024)
      throw new AccountAttachmentExportMissing("Invalid AI attachment metadata");
    return { url: file.url as string, name: file.name, type: file.type,
      size: file.size };
  });
}

/** Run under the same transaction that holds the session and membership
 * locks through ZIP delivery. Comment edits/deletes cannot detach an original
 * after this row check and before its bytes are streamed. */
export async function ownAttachmentsStillCurrent(
  client: PoolClient,
  accountId: string,
  attachments: Array<OwnCommentAttachment | OwnAiAttachment>,
) {
  const byArchive = new Map<string, OwnCommentAttachment[]>();
  for (const attachment of attachments) {
    if (!("commentId" in attachment)) continue;
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
  const aiByArchive = new Map<string, OwnAiAttachment[]>();
  for (const attachment of attachments) {
    if (!("chatId" in attachment)) continue;
    const list = aiByArchive.get(attachment.archiveId) || [];
    list.push(attachment);
    aiByArchive.set(attachment.archiveId, list);
  }
  for (const [archiveId, files] of aiByArchive) {
    await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
    const ids = [...new Set(files.map((file) => file.messageId))];
    const rows = await client.query(
      `SELECT m.id,m.chat_id,m.data->'attachments' AS attachments,
              m.data->>'hidden' AS hidden,c.user_id,c.access_scope
         FROM ai_chat_messages m JOIN ai_chats c
           ON c.archive_id=m.archive_id AND c.id=m.chat_id
        WHERE m.id=ANY($1::bigint[]) AND c.user_id=$2
        FOR SHARE OF m,c NOWAIT`, [ids, accountId],
    );
    const current = new Map(rows.rows.map((row) => [String(row.id), row]));
    for (const attachment of files) {
      const row = current.get(attachment.messageId);
      if (!row || row.hidden === "true" || row.chat_id !== attachment.chatId ||
          row.access_scope !== attachment.accessScope) return false;
      try {
        if (!aiFilesFromJson(row.attachments, attachment.chatId).some((file) =>
          file.url === attachment.file.url && file.name === attachment.file.name &&
          file.type === attachment.file.type && file.size === attachment.file.size))
          return false;
      } catch (error) {
        if (error instanceof AccountAttachmentExportMissing) return false;
        throw error;
      }
    }
  }
  return true;
}

type PreparedFile = {
  size: number;
  path: string;
  source: string;
  sha256: string;
  dev: number;
  ino: number;
  manifest: Record<string, unknown>;
};

async function hashOriginal(source: string, expectedSize: number, signal?: AbortSignal) {
  let info;
  try {
    info = await lstat(source);
  } catch {
    throw new AccountAttachmentExportMissing("Discussion original is missing");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedSize)
    throw new AccountAttachmentExportMissing("Discussion original changed");
  let handle;
  try {
    handle = await open(source, readFlags);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== expectedSize ||
        opened.dev !== info.dev || opened.ino !== info.ino)
      throw new AccountAttachmentExportMissing("Discussion original changed");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      hash.update(buffer);
    }
    if (bytes !== expectedSize)
      throw new AccountAttachmentExportMissing("Discussion original changed");
    return { sha256: hash.digest("hex"), dev: opened.dev, ino: opened.ino };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof AccountAttachmentExportMissing) throw error;
    throw new AccountAttachmentExportMissing("Discussion original is unreadable");
  } finally {
    await handle?.close();
  }
}

/** Prepare an account-only bundle without retaining file contents in memory.
 * Names are metadata in the manifest; ZIP entry paths use generated indexes
 * and validated UUIDs, so an uploaded name cannot become a path. */
export async function prepareAccountAttachmentExport(
  attachments: Array<OwnCommentAttachment | OwnAiAttachment>,
  uploadsForArchive: (archiveId: string) => string,
  signal?: AbortSignal,
) {
  if (attachments.length > MAX_ACCOUNT_ATTACHMENT_FILES)
    throw new AccountAttachmentExportTooLarge("Too many discussion originals");
  const total = attachments.reduce((sum, attachment) => sum + attachment.file.size, 0);
  if (!Number.isSafeInteger(total) || total > MAX_ACCOUNT_ATTACHMENT_BYTES)
    throw new AccountAttachmentExportTooLarge("Discussion originals exceed export limit");
  const files: PreparedFile[] = [];
  for (const attachment of attachments) {
    signal?.throwIfAborted();
    if (!archiveIdPattern.test(attachment.archiveId))
      throw new AccountAttachmentExportMissing("Invalid archive ID");
    const ai = "chatId" in attachment;
    const aiMatch = ai ? aiFileUrl.exec(attachment.file.url) : null;
    const id = ai ? aiMatch?.[2] : attachment.file.id;
    if (!id || (ai
      ? aiMatch?.[1] !== attachment.chatId ||
        aiFilesFromJson([attachment.file], attachment.chatId).length !== 1
      : !commentFileId.test(id)))
      throw new AccountAttachmentExportMissing("Invalid account attachment ID");
    const source = ai
      ? join(uploadsForArchive(attachment.archiveId), "ai-chat-files", attachment.chatId, id)
      : join(uploadsForArchive(attachment.archiveId), "discussion-files", id);
    const identity = await hashOriginal(source, attachment.file.size, signal);
    files.push({
      size: attachment.file.size,
      source,
      ...identity,
      path: `files/${files.length + 1}-${id}`,
      manifest: ai
        ? { kind: "ai", archiveId: attachment.archiveId,
          chatId: attachment.chatId, messageId: attachment.messageId,
          id, name: attachment.file.name, type: attachment.file.type,
          size: attachment.file.size }
        : { kind: "discussion", archiveId: attachment.archiveId,
          personId: attachment.personId, commentId: attachment.commentId,
          id, name: attachment.file.name, type: attachment.file.type,
          size: attachment.file.size },
    });
  }
  const manifest = {
    format: "drevo-account-attachments",
    version: 2,
    exportedAt: new Date().toISOString(),
    attachments: files.map(({ manifest, path, sha256 }) => ({ ...manifest, path, sha256 })),
  };
  const manifestData = Buffer.from(JSON.stringify(manifest));
  if (manifestData.length > 24 * 1024 * 1024)
    throw new AccountAttachmentExportTooLarge("Discussion manifest exceeds export limit");
  return {
    async writeTo(destination: Writable, streamSignal?: AbortSignal) {
      const zip = new ZipFile();
      const output = pipeline(zip.outputStream, destination, { signal: streamSignal });
      void output.catch(() => {});
      zip.on("error", (error) => (zip.outputStream as Readable).destroy(error));
      try {
        zip.addBuffer(manifestData, "manifest.json");
        for (const file of files) {
          zip.addReadStreamLazy(file.path, { compress: false, size: file.size },
            (callback) => {
              void (async () => {
                const handle = await open(file.source, readFlags);
                try {
                  const info = await handle.stat();
                  if (!info.isFile() || info.size !== file.size ||
                      info.dev !== file.dev || info.ino !== file.ino)
                    throw new AccountAttachmentExportMissing("Discussion original changed during export");
                  const source = handle.createReadStream({ signal: streamSignal });
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
                } catch (error) {
                  await handle.close();
                  callback(streamOriginalError(error), null as unknown as Readable);
                }
              })().catch((error) => callback(streamOriginalError(error), null as unknown as Readable));
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
