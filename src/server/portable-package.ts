import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";
import { ZipFile } from "yazl";
import type { Family } from "../domain/types.ts";
import type { DocumentAnnotation } from "../shared/document-annotations.ts";
import type { DocumentEventLink, DocumentPage } from "../shared/document-links.ts";
import { documentFileTypeFromName } from "../shared/document-file.ts";

const MAX_ARCHIVE_JSON_BYTES = 128 * 1024 * 1024;
const originalName = /^[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif|pdf)$/;

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
  text: string;
};

export type PortableSnapshot = {
  family: Family;
  documents: PortableDocument[];
  comments: PortableComment[];
};

export type PortableManifest = {
  format: "drevo";
  version: 1;
  exportedAt: string;
  entries: Array<{ path: string; size: number; sha256: string }>;
};

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
  const entries: PortableManifest["entries"] = [
    { path: "archive.json", size: data.length, sha256: sha256(data) },
  ];
  for (const name of names) {
    if (signal?.aborted) throw signal.reason;
    const digest = await hashOriginal(join(uploads, name), signal);
    entries.push({ path: `media/${name}`, ...digest });
  }
  const manifest: PortableManifest = {
    format: "drevo",
    version: 1,
    exportedAt: new Date().toISOString(),
    entries,
  };
  if (signal?.aborted) throw signal.reason;
  await beforeStart();
  const zip = new ZipFile();
  const output = pipeline(zip.outputStream, destination, { signal });
  void output.catch(() => {});
  zip.on("error", (error) => (zip.outputStream as Readable).destroy(error));
  try {
    zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json");
    zip.addBuffer(data, "archive.json");
    for (const name of names)
      zip.addFile(join(uploads, name), `media/${name}`, { compress: false });
    zip.end();
    await output;
  } catch (error) {
    (zip.outputStream as Readable).destroy(error as Error);
    await output.catch(() => {});
    throw error;
  }
  return manifest;
}
