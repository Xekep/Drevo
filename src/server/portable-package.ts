import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";
import { ZipFile } from "yazl";
import type { Family } from "../domain/types.ts";
import type { CatalogSource } from "../shared/source-catalog.ts";
import type { DocumentAnnotation } from "../shared/document-annotations.ts";
import type { DocumentEventLink, DocumentPage } from "../shared/document-links.ts";
import { documentFileTypeFromName } from "../shared/document-file.ts";
import { validCommentFiles, type CommentAttachmentFile } from "../shared/person-discussion.ts";
import { allCitations } from "./source-catalog-store.ts";

const MAX_ARCHIVE_JSON_BYTES = 128 * 1024 * 1024;
export const MAX_PORTABLE_ENTRIES = 50_000;
// A manifest with 50,000 media paths (up to a filesystem component each) can
// exceed 8 MiB. Keep a finite bound that can represent every allowed entry.
export const MAX_PORTABLE_MANIFEST_BYTES = 24 * 1024 * 1024;
const originalName = /^[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif|tif|pdf)$/;

export class PortablePackageError extends Error {}

export type PortableDocument = {
  id: string;
  title: string;
  fileName: string;
  createdAt: string;
  uploadedBy: string;
  documentType: string;
  documentDate: string;
  place: string;
  description: string;
  provenance: string;
  annotations: DocumentAnnotation[];
  personIds: string[];
  eventLinks?: DocumentEventLink[];
  pages?: DocumentPage[];
};

export type PortableComment = {
  id: number;
  personId: string;
  authorId: string;
  authorName: string;
  createdMs: number;
  editedMs?: number | null;
  text: string;
  attachments?: CommentAttachmentFile[];
};

export type PortableSnapshot = {
  family: Family;
  documents: PortableDocument[];
  comments: PortableComment[];
  sources?: CatalogSource[];
};

export type PortableManifest = {
  format: "drevo";
  version: 1;
  exportedAt: string;
  entries: Array<{ path: string; size: number; sha256: string }>;
};

/** Inline citations may point at a local original without a photo or
 * document record. Keep the URL suffix while moving its original to a new
 * archive's media directory. External URLs remain ordinary links.
 */
export function portableCitationMedia(url: string) {
  if (!url.startsWith("/media/")) return null;
  const path = url.slice(7);
  const suffixAt = path.search(/[?#]/);
  const name = suffixAt < 0 ? path : path.slice(0, suffixAt);
  if (!originalName.test(name))
    throw new PortablePackageError("Некорректный путь оригинала источника");
  return { name, suffix: suffixAt < 0 ? "" : path.slice(suffixAt) };
}

function fileNames(snapshot: PortableSnapshot) {
  const names = new Set<string>();
  for (const person of snapshot.family.people) {
    if (!person.photo) continue;
    if (/^https?:\/\//i.test(person.photo)) continue;
    const match = /^\/media\/(.+)$/.exec(person.photo);
    if (!match || !originalName.test(match[1]))
      throw new PortablePackageError("Некорректный путь оригинала портрета");
    names.add(match[1]);
  }
  for (const photo of snapshot.family.photos || []) {
    if (/^https?:\/\//i.test(photo.url)) continue;
    const match = /^\/media\/(.+)$/.exec(photo.url);
    if (!match || !originalName.test(match[1]))
      throw new PortablePackageError("Некорректный путь оригинала фотографии");
    names.add(match[1]);
  }
  for (const document of snapshot.documents) {
    if (
      !originalName.test(document.fileName) ||
      !documentFileTypeFromName(document.fileName)
    )
      throw new PortablePackageError("Некорректный путь оригинала документа");
    names.add(document.fileName);
  }
  for (const comment of snapshot.comments) {
    if (comment.attachments && !validCommentFiles(comment.attachments))
      throw new PortablePackageError("Некорректные вложения обсуждения");
    for (const file of comment.attachments || []) names.add(`discussion-files/${file.id}`);
  }
  for (const citation of allCitations(snapshot.family)) {
    const local = citation.url && portableCitationMedia(citation.url);
    if (local) names.add(local.name);
  }
  return [...names].sort();
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function hashOriginal(path: string, signal?: AbortSignal) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new PortablePackageError("Оригинал не является обычным файлом");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    hash.update(bytes);
  }
  if (size !== info.size)
    throw new PortablePackageError("Оригинал изменился во время экспорта");
  return { size, sha256: hash.digest("hex") };
}

/** This is an archival snapshot, not a system backup. No account credentials,
 * access grants, AI chats, server settings or secrets are included.
 */
export async function writePortablePackage(
  destination: Writable,
  uploads: string,
  snapshot: PortableSnapshot,
  beforeStart: () => Promise<void>,
  signal?: AbortSignal,
) {
  const data = Buffer.from(JSON.stringify(snapshot));
  if (data.length > MAX_ARCHIVE_JSON_BYTES)
    throw new PortablePackageError(
      "Данные дерева слишком велики для одного пакета",
    );
  const names = fileNames(snapshot);
  // The ZIP also contains manifest.json and archive.json.
  if (names.length + 2 > MAX_PORTABLE_ENTRIES)
    throw new PortablePackageError("В пакете Drevo слишком много файлов");
  const entries: PortableManifest["entries"] = [
    { path: "archive.json", size: data.length, sha256: sha256(data) },
  ];
  const originals = new Map<string, Awaited<ReturnType<typeof hashOriginal>>>();
  for (const name of names) {
    if (signal?.aborted) throw signal.reason;
    const digest = await hashOriginal(join(uploads, name), signal);
    originals.set(name, digest);
    entries.push({ path: `media/${name}`, ...digest });
  }
  const manifest: PortableManifest = {
    format: "drevo",
    version: 1,
    exportedAt: new Date().toISOString(),
    entries,
  };
  const manifestData = Buffer.from(JSON.stringify(manifest));
  if (manifestData.length > MAX_PORTABLE_MANIFEST_BYTES)
    throw new PortablePackageError("Манифест пакета Drevo слишком велик");
  if (signal?.aborted) throw signal.reason;
  await beforeStart();
  const zip = new ZipFile();
  const output = pipeline(zip.outputStream, destination, { signal });
  void output.catch(() => {});
  zip.on("error", (error) => (zip.outputStream as Readable).destroy(error));
  try {
    zip.addBuffer(manifestData, "manifest.json");
    zip.addBuffer(data, "archive.json");
    // ZIP checks size and CRC, but a same-size edit after prehashing would make
    // the published SHA-256 manifest false unless we verify the streamed bytes.
    for (const name of names) {
      const expected = originals.get(name)!;
      zip.addReadStreamLazy(`media/${name}`, { compress: false, size: expected.size },
        (callback) => {
          const source = createReadStream(join(uploads, name), { signal });
          const actual = createHash("sha256");
          const checked = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              actual.update(chunk);
              done(null, chunk);
            },
            flush(done) {
              done(actual.digest("hex") === expected.sha256
                ? undefined
                : new PortablePackageError("Оригинал изменился во время экспорта"));
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
  return manifest;
}
