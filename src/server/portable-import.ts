import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { openPromise } from "yauzl";
import { randomUUID } from "node:crypto";
import { validateFamily } from "../domain/validation.ts";
import { validAnnotationSelection } from "../shared/document-annotations.ts";
import { parseDocumentDetails } from "../shared/document-details.ts";
import { verifyPortableMediaFile } from "./portable-media-check.ts";
import {
  PortablePackageError,
  type PortableComment,
  type PortableDocument,
  type PortableManifest,
  type PortableSnapshot,
} from "./portable-package.ts";

export const PORTABLE_IMPORT_LIMIT = 12 * 1024 ** 3;
const MAX_ENTRIES = 50_000;
const MAX_MANIFEST = 8 * 1024 ** 2;
const MAX_ARCHIVE_JSON = 128 * 1024 ** 2;
const MAX_ORIGINAL = 1024 ** 3;
const uuid = /^[a-f0-9-]{36}$/i;
const mediaPath = /^media\/[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif|pdf)$/;
const digest = /^[a-f0-9]{64}$/;

function invalid(message: string): never {
  throw new PortablePackageError(message);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("Некорректный формат пакета Drevo");
  return value as Record<string, unknown>;
}

function manifestFrom(value: unknown): PortableManifest {
  const data = object(value);
  if (
    data.format !== "drevo" ||
    data.version !== 1 ||
    typeof data.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(data.exportedAt)) ||
    !Array.isArray(data.entries) ||
    data.entries.length > MAX_ENTRIES
  )
    invalid("Неподдерживаемая версия пакета Drevo");
  const paths = new Set<string>();
  for (const raw of data.entries) {
    const entry = object(raw);
    if (
      typeof entry.path !== "string" ||
      (entry.path !== "archive.json" && !mediaPath.test(entry.path)) ||
      paths.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      (entry.size as number) > PORTABLE_IMPORT_LIMIT ||
      typeof entry.sha256 !== "string" ||
      !digest.test(entry.sha256)
    )
      invalid("Некорректный список вложений пакета Drevo");
    paths.add(entry.path);
  }
  if (!paths.has("archive.json")) invalid("Нет данных дерева в пакете Drevo");
  return data as PortableManifest;
}

function snapshotFrom(value: unknown): PortableSnapshot {
  const data = object(value);
  const family = validateFamily(data.family);
  if (
    !Array.isArray(data.documents) ||
    !Array.isArray(data.comments) ||
    data.documents.length > 50_000 ||
    data.comments.length > 100_000
  )
    invalid("В пакете отсутствуют документы или обсуждения");
  const people = new Set(family.people.map((person) => person.id));
  const documentIds = new Set<string>();
  const documentFiles = new Set<string>();
  const documents: PortableDocument[] = [];
  for (const raw of data.documents) {
    const document = object(raw);
    if (
      typeof document.id !== "string" ||
      !uuid.test(document.id) ||
      documentIds.has(document.id) ||
      typeof document.fileName !== "string" ||
      !/^[a-zA-Z0-9-]+\.pdf$/.test(document.fileName) ||
      documentFiles.has(document.fileName) ||
      typeof document.title !== "string" ||
      !document.title.trim() ||
      document.title.length > 160 ||
      !parseDocumentDetails(document) ||
      !Number.isFinite(Date.parse(String(document.createdAt))) ||
      ![
        "createdAt",
        "uploadedBy",
        "documentType",
        "documentDate",
        "place",
        "description",
        "provenance",
      ].every(
        (key) =>
          typeof document[key] === "string" &&
          (document[key] as string).length <= 10_000,
      ) ||
      !Array.isArray(document.personIds) ||
      !document.personIds.every(
        (id) => typeof id === "string" && people.has(id),
      ) ||
      new Set(document.personIds).size !== document.personIds.length ||
      !Array.isArray(document.annotations) ||
      document.annotations.length > 500
    )
      invalid("Некорректный документ в пакете Drevo");
    for (const rawAnnotation of document.annotations) {
      const annotation = object(rawAnnotation);
      const metadata: Record<string, unknown> = annotation;
      if (
        !validAnnotationSelection(annotation) ||
        typeof metadata.id !== "string" ||
        !uuid.test(metadata.id) ||
        typeof metadata.authorId !== "string" ||
        metadata.authorId.length > 200 ||
        typeof metadata.authorName !== "string" ||
        metadata.authorName.length > 200 ||
        typeof metadata.createdAt !== "string"
      )
        invalid("Некорректная аннотация документа");
    }
    documentIds.add(document.id);
    documentFiles.add(document.fileName);
    documents.push(document as PortableDocument);
  }
  for (const person of family.people) {
    const sources = [
      ...person.sources,
      ...(person.events || []).flatMap((event) => event.sources || []),
    ];
    if (
      sources.some(
        (source) => source.documentId && !documentIds.has(source.documentId),
      )
    )
      invalid("Источник ссылается на отсутствующий документ");
  }
  const commentIds = new Set<number>();
  const comments: PortableComment[] = [];
  for (const raw of data.comments) {
    const comment = object(raw);
    if (
      !Number.isSafeInteger(comment.id) ||
      (comment.id as number) < 1 ||
      commentIds.has(comment.id as number) ||
      typeof comment.personId !== "string" ||
      !people.has(comment.personId) ||
      typeof comment.authorId !== "string" ||
      typeof comment.authorName !== "string" ||
      comment.authorId.length > 200 ||
      comment.authorName.length > 200 ||
      !Number.isSafeInteger(comment.createdMs) ||
      typeof comment.text !== "string" ||
      !comment.text.trim() ||
      comment.text.length > 2000
    )
      invalid("Некорректное обсуждение в пакете Drevo");
    commentIds.add(comment.id as number);
    comments.push(comment as PortableComment);
  }
  return { family, documents, comments };
}

export async function readPortablePackage(
  input: string,
  directory: string,
  signal?: AbortSignal,
) {
  if ((await stat(input)).size > PORTABLE_IMPORT_LIMIT)
    invalid("Пакет Drevo больше 12 ГиБ");
  const zip = await openPromise(input, {
    strictFileNames: false,
    validateEntrySizes: true,
  });
  const files = new Map<
    string,
    { path: string; size: number; sha256: string }
  >();
  let total = 0;
  try {
    if (zip.entryCount > MAX_ENTRIES)
      invalid("В пакете Drevo слишком много файлов");
    for await (const entry of zip.eachEntry()) {
      if (signal?.aborted) throw signal.reason;
      const name = entry.fileName;
      const limit =
        name === "manifest.json"
          ? MAX_MANIFEST
          : name === "archive.json"
            ? MAX_ARCHIVE_JSON
            : MAX_ORIGINAL;
      if (
        files.has(name) ||
        (name !== "manifest.json" &&
          name !== "archive.json" &&
          !mediaPath.test(name)) ||
        entry.isEncrypted() ||
        ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 ||
        entry.uncompressedSize > limit ||
        entry.uncompressedSize < 0
      )
        invalid("Недопустимое вложение в пакете Drevo");
      total += entry.uncompressedSize;
      if (total > PORTABLE_IMPORT_LIMIT)
        invalid("Распакованный пакет Drevo больше 12 ГиБ");
      const disk = await statfs(directory);
      if (disk.bavail * disk.bsize < entry.uncompressedSize + 128 * 1024 ** 2)
        invalid("Недостаточно места для распаковки пакета Drevo");
      const target = join(directory, randomUUID());
      const hash = createHash("sha256");
      let size = 0;
      let checksum = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (
            size > limit ||
            total - entry.uncompressedSize + size > PORTABLE_IMPORT_LIMIT
          )
            return callback(
              new PortablePackageError("Вложение слишком велико"),
            );
          hash.update(chunk);
          checksum = crc32(chunk, checksum);
          callback(null, chunk);
        },
      });
      await pipeline(
        await zip.openReadStreamPromise(entry),
        guard,
        createWriteStream(target, { flags: "wx" }),
        { signal },
      );
      if (size !== entry.uncompressedSize || checksum !== entry.crc32)
        invalid("Повреждён файл ZIP");
      files.set(name, { path: target, size, sha256: hash.digest("hex") });
    }
  } finally {
    zip.close();
  }
  const manifestFile = files.get("manifest.json");
  const archiveFile = files.get("archive.json");
  if (!manifestFile || !archiveFile)
    invalid("Нет манифеста или данных дерева в пакете Drevo");
  let manifest: PortableManifest;
  let snapshot: PortableSnapshot;
  try {
    manifest = manifestFrom(
      JSON.parse((await readFile(manifestFile.path)).toString("utf8")),
    );
    snapshot = snapshotFrom(
      JSON.parse((await readFile(archiveFile.path)).toString("utf8")),
    );
  } catch (error) {
    if (error instanceof PortablePackageError) throw error;
    invalid("Некорректный JSON в пакете Drevo");
  }
  const listed = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  if (listed.size !== files.size - 1)
    invalid("Манифест не соответствует содержимому пакета");
  for (const [name, file] of files) {
    if (name === "manifest.json") continue;
    const expected = listed.get(name);
    if (
      !expected ||
      expected.size !== file.size ||
      expected.sha256 !== file.sha256
    )
      invalid("Повреждён файл пакета Drevo: SHA-256 не совпадает");
  }
  for (const [name, file] of files)
    if (name.startsWith("media/"))
      await verifyPortableMediaFile(file.path, name);
  const expectedMedia = new Set<string>();
  for (const person of snapshot.family.people)
    if (person.photo?.startsWith("/media/"))
      expectedMedia.add(`media/${person.photo.slice(7)}`);
  for (const photo of snapshot.family.photos || [])
    if (photo.url.startsWith("/media/"))
      expectedMedia.add(`media/${photo.url.slice(7)}`);
  for (const document of snapshot.documents)
    expectedMedia.add(`media/${document.fileName}`);
  const actualMedia = new Set(
    [...files.keys()].filter((name) => name.startsWith("media/")),
  );
  if (
    actualMedia.size !== expectedMedia.size ||
    [...expectedMedia].some((name) => !actualMedia.has(name))
  )
    invalid("В пакете отсутствует оригинал или есть лишний файл");
  return { snapshot, manifest, files };
}
