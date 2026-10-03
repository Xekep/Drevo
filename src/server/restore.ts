import { MAX_PDF_BYTES } from "../shared/upload-limits.ts";
import { storedDocumentFileType } from "../shared/document-file.ts";
import { storeDatabase } from "./store-database.ts";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import {
  copyFile,
  open as openFile,
  rename,
  rm,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import {
  readArchive,
  ConflictError,
  type openArchive,
  type StoredFaceDescriptor,
} from "./database.ts";
import { writeDatabaseBackup } from "./backup.ts";
import { mediaPattern, originalMediaPattern } from "./media.ts";
import { portableCitationMedia } from "./portable-package.ts";
import { verifyPortableMediaFile } from "./portable-media-check.ts";
import { recordMediaOriginal } from "./media-originals.ts";
import { enforcePostgresMediaQuota } from "./postgres-media-quota.ts";
import { reservePlatformDisk } from "./platform-disk-reservation.ts";
import {
  documentSearchText,
  parseDocumentDetails,
  type DocumentDetails,
} from "../shared/document-details.ts";
import { validateFamily, type Family, type Source } from "../domain/index.ts";
import type { ArchiveUser } from "../domain/access.ts";
import type { StoreDatabase } from "./store-database.ts";
import {
  parseCatalogSource,
  type CatalogSource,
} from "../shared/source-catalog.ts";
import { allCitations, sourceCatalogStore } from "./source-catalog-store.ts";

const RESTORE_LIMIT = 12 * 1024 * 1024 * 1024;
const RESERVATION_STEP = 32 * 1024 * 1024;
export class RestoreTooLargeError extends Error {}

function removeStage(directory: string, stagingRoot: string) {
  const path = resolve(directory);
  if (
    dirname(path) !== resolve(stagingRoot) ||
    !basename(path).startsWith("restore-")
  )
    throw new Error("Недопустимый временный каталог");
  rmSync(path, { recursive: true, force: true });
}
const SQLITE_LIMIT = 512 * 1024 * 1024,
  UNPACKED_LIMIT = 12 * 1024 * 1024 * 1024;
const references = (family: Family) => {
  const images = [
    ...family.people.map((p) => p.photo),
    ...(family.photos || []).map((p) => p.url),
  ].filter((url): url is string => !!url && url.startsWith("/media/"));
  if (images.some((url) => !mediaPattern.test(url)))
    throw new Error("Недопустимое имя фотографии в базе");
  const citations = allCitations(family).flatMap((source) => {
    const local = source.url && portableCitationMedia(source.url);
    return local ? [`/media/${local.name}`] : [];
  });
  return [...new Set([...images, ...citations])];
};

async function streamUpload(
  source: Readable,
  file: string,
  reserveBytes: (bytes: number) => Promise<void>,
) {
  let size = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      if (size + bytes.length > RESTORE_LIMIT) {
        callback(
          new RestoreTooLargeError("Файл слишком большой. Максимум 12 ГиБ."),
        );
        return;
      }
      reserveBytes(bytes.length).then(() => {
        size += bytes.length;
        callback(null, bytes);
      }, callback);
    },
  });
  await pipeline(
    source,
    guard,
    createWriteStream(file, { flags: "wx", mode: 0o600 }),
  );
  if (!size) throw new Error("Бэкап должен быть не больше 12 ГиБ");
  return size;
}

async function fileHeader(file: string) {
  const handle = await openFile(file, "r");
  try {
    const header = Buffer.alloc(16),
      { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Читаем только ожидаемые файлы собственного бэкапа; ссылки и пути наружу запрещены. */
async function unpack(
  source: Readable,
  directory: string,
  reserveBytes: (bytes: number) => Promise<void>,
) {
  const stream = source.pipe(createGunzip());
  let pending = Buffer.alloc(0),
    total = 0,
    remaining = 0,
    padding = 0,
    name = "",
    paxContent: Buffer[] = [],
    files = 0,
    entryFd: number | undefined;
  let pax = false,
    nextPath: string | undefined;
  const seen = new Set<string>();

  function finish() {
    if (entryFd !== undefined) {
      const fd = entryFd;
      entryFd = undefined;
      closeSync(fd);
    }
    if (pax) {
      const data = Buffer.concat(paxContent);
      let offset = 0;
      while (offset < data.length) {
        const space = data.indexOf(32, offset),
          length = Number(data.toString("ascii", offset, space));
        if (
          space < 0 ||
          !Number.isInteger(length) ||
          length <= space - offset + 1 ||
          offset + length > data.length
        )
          throw new Error("Повреждён заголовок архива");
        const record = data.toString("utf8", space + 1, offset + length - 1),
          eq = record.indexOf("=");
        if (record.slice(0, eq) === "path") nextPath = record.slice(eq + 1);
        if (record.slice(0, eq) === "linkpath")
          throw new Error("Ссылки в бэкапе не поддерживаются");
        offset += length;
      }
    }
    paxContent = [];
    name = "";
    pax = false;
  }

  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > UNPACKED_LIMIT)
        throw new Error("Распакованный бэкап больше 12 ГиБ");
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        if (remaining) {
          const take = Math.min(remaining, pending.length),
            bytes = pending.subarray(0, take);
          if (pax) paxContent.push(Buffer.from(bytes));
          else if (entryFd !== undefined) {
            let offset = 0;
            while (offset < bytes.length) {
              const written = writeSync(
                entryFd,
                bytes,
                offset,
                bytes.length - offset,
              );
              if (!written) throw new Error("Не удалось распаковать файл");
              offset += written;
            }
          }
          pending = pending.subarray(take);
          remaining -= take;
          if (!remaining) finish();
        } else if (padding) {
          const take = Math.min(padding, pending.length);
          pending = pending.subarray(take);
          padding -= take;
        } else {
          if (pending.length < 512) break;
          const header = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (header.every((b) => b === 0)) continue;
          const field = (start: number, end: number) =>
            header.toString("utf8", start, end).split("\0")[0];
          const checksum = parseInt(field(148, 156).trim(), 8);
          if (
            header.reduce(
              (sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b),
              0,
            ) !== checksum
          )
            throw new Error("Повреждён заголовок TAR");
          const sizeText = field(124, 136).trim();
          if (!/^[0-7]+$/.test(sizeText))
            throw new Error("Некорректный размер файла");
          remaining = parseInt(sizeText, 8);
          padding = (512 - (remaining % 512)) % 512;
          const type = field(156, 157),
            prefix = field(345, 500);
          name = nextPath || (prefix ? `${prefix}/` : "") + field(0, 100);
          nextPath = undefined;
          pax = type === "x" || type === "g";
          if (++files > 40_010)
            throw new Error("В бэкапе слишком много файлов");
          if (pax) {
            if (remaining > 65536)
              throw new Error("Слишком большой заголовок TAR");
          } else if (
            type === "5" &&
            remaining === 0 &&
            (name === "uploads/" ||
              /^uploads\/(?:discussion-files|ai-chat-files)\/$/.test(name) ||
              /^uploads\/ai-chat-files\/[a-f0-9-]{36}\/$/.test(name))
          )
            name = "";
          else {
            if (type !== "0" && type !== "")
              throw new Error("В бэкапе допустимы только обычные файлы");
            // A full system backup contains private discussion/AI attachments.
            // Family import deliberately leaves comments and AI chats alone,
            // so validate their paths and sizes but do not stage their bytes.
            const privateAttachment =
              /^uploads\/discussion-files\/[a-f0-9-]{36}(?:\.webp)?$/.test(
                name,
              ) ||
              /^uploads\/ai-chat-files\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(
                name,
              );
            if (
              name !== "drevo.sqlite" &&
              name !== "drevo.sqlite.secrets.key" &&
              !privateAttachment &&
              !/^uploads\/[a-zA-Z0-9-]+\.(jpg|png|webp|gif|tif|pdf)$/.test(name)
            )
              throw new Error("Недопустимый путь в бэкапе");
            // Full disaster-recovery backups include the encryption key. The
            // UI import stages it only; it never replaces live settings/keys.
            if (name === "drevo.sqlite.secrets.key" && remaining !== 32)
              throw new Error("Некорректный ключ в бэкапе");
            if (
              remaining >
              (name === "drevo.sqlite"
                ? SQLITE_LIMIT
                : /\.(?:pdf|tif)$/.test(name)
                  ? MAX_PDF_BYTES
                  : 20 * 1024 * 1024)
            )
              throw new Error("Один из файлов бэкапа слишком большой");
            if (seen.has(name))
              throw new Error("Повторяющееся имя файла в бэкапе");
            seen.add(name);
            if (!privateAttachment) {
              if (remaining) await reserveBytes(remaining);
              entryFd = openSync(join(directory, name), "wx", 0o600);
            }
          }
          if (!remaining) finish();
        }
      }
    }
    if (remaining || padding || pending.length)
      throw new Error("Бэкап оборван");
  } finally {
    if (entryFd !== undefined) closeSync(entryFd);
  }
}

type Stage = {
  directory: string;
  family: Family;
  actor: string;
  revision: number;
  expires: number;
  files: Map<string, string>;
  faceDescriptors: StoredFaceDescriptor[];
  documents: StoredDocument[];
  documentFiles: Map<string, string>;
  catalogSources: Array<CatalogSource & { version: number }>;
};

type StoredDocument = Partial<DocumentDetails> & {
  id: string;
  title: string;
  fileName: string;
  fileSize: number;
  uploadedBy: string;
  createdAt: string;
  annotations?: string;
  eventLinks?: string;
  pages?: string;
  personIds: string[];
};

export function restoreStore(
  archive: Awaited<ReturnType<typeof openArchive>>,
  dbPath: string,
) {
  const stagingRoot = join(dirname(dbPath), "staging");
  mkdirSync(stagingRoot, { recursive: true });
  const readStage = async (token: string): Promise<Stage | undefined> => {
    const row = await archive.db
      .prepare(
        "SELECT actor_id,revision,expires_at,data,directory FROM workflow_stages WHERE kind='restore' AND token=?",
        "SELECT actor_id,revision,expires_at,data,directory FROM workflow_stages WHERE kind='restore' AND token=?",
      )
      .get(token);
    if (!row) return undefined;
    const data = JSON.parse(String(row.data)) as {
      family: Family;
      files: [string, string][];
      faceDescriptors: StoredFaceDescriptor[];
      documents?: StoredDocument[];
      documentFiles?: [string, string][];
      catalogSources?: Array<CatalogSource & { version: number }>;
    };
    return {
      directory: String(row.directory),
      family: data.family,
      actor: String(row.actor_id),
      revision: Number(row.revision),
      expires: Number(row.expires_at),
      files: new Map(data.files),
      faceDescriptors: data.faceDescriptors,
      documents: data.documents || [],
      documentFiles: new Map(data.documentFiles || []),
      catalogSources: data.catalogSources || [],
    };
  };
  const discard = async (token: string) => {
    const stage = await readStage(token);
    if (stage) removeStage(stage.directory, stagingRoot);
    await archive.db
      .prepare(
        "DELETE FROM workflow_stages WHERE kind='restore' AND token=?",
        "DELETE FROM workflow_stages WHERE kind='restore' AND token=?",
      )
      .run(token);
  };
  const clean = async () => {
    const expired = await archive.db
      .prepare(
        "SELECT token FROM workflow_stages WHERE kind='restore' AND expires_at<?",
        "SELECT token FROM workflow_stages WHERE kind='restore' AND expires_at<?",
      )
      .all(Date.now());
    for (const row of expired) await discard(String(row.token));
  };
  let cleaning: Promise<void> | undefined;
  const cleanup = setInterval(() => {
    if (cleaning) return;
    cleaning = clean()
      .catch(() => {
        console.warn("restore_stage_cleanup_failed");
      })
      .finally(() => {
        cleaning = undefined;
      });
  }, 60000);
  cleanup.unref();

  async function previewStream(
    sourceStream: Readable,
    actor: ArchiveUser,
    assertAccess?: () => void | Promise<void>,
  ) {
    if (actor.role !== "admin")
      throw new Error("Восстановление доступно администратору");
    const obsolete = await archive.db
      .prepare(
        "SELECT token FROM workflow_stages WHERE kind='restore' AND (actor_id=? OR expires_at<?)",
        "SELECT token FROM workflow_stages WHERE kind='restore' AND (actor_id=? OR expires_at<?)",
      )
      .all(actor.id, Date.now());
    for (const row of obsolete) await discard(String(row.token));
    const active = Number(
      (await archive.db
        .prepare(
          "SELECT count(*) AS count FROM workflow_stages WHERE kind='restore'",
          "SELECT count(*) AS count FROM workflow_stages WHERE kind='restore'",
        )
        .get())!.count,
    );
    if (active >= 3)
      throw new Error("Уже проверяется несколько бэкапов. Повторите позже.");

    const directory = mkdtempSync(join(stagingRoot, "restore-")),
      upload = join(directory, ".upload");
    mkdirSync(join(directory, "uploads"));
    let reservation:
      Awaited<ReturnType<typeof reservePlatformDisk>> | undefined;
    let neededBytes = 0;
    let reservedBytes = 0;
    const reserveBytes = async (bytes: number) => {
      neededBytes += bytes;
      if (neededBytes <= reservedBytes) return;
      const target =
        Math.ceil(neededBytes / RESERVATION_STEP) * RESERVATION_STEP;
      const freeBytes = async () => {
        const disk = await statfs(stagingRoot);
        return disk.bavail * disk.bsize;
      };
      if (reservation) await reservation.grow(target - reservedBytes);
      else
        reservation = await reservePlatformDisk(archive.db, target, freeBytes);
      reservedBytes = target;
    };
    try {
      const size = await streamUpload(sourceStream, upload, reserveBytes);
      await assertAccess?.();
      const header = await fileHeader(upload);
      if (header.toString("binary") === "SQLite format 3\0") {
        if (size > SQLITE_LIMIT) throw new Error("База больше 512 МБ");
        await rename(upload, join(directory, "drevo.sqlite"));
      } else if (header[0] === 31 && header[1] === 139) {
        await unpack(createReadStream(upload), directory, reserveBytes);
        await unlink(upload);
      } else throw new Error("Выберите бэкап Drevo: .sqlite или .tar.gz");

      const source = new DatabaseSync(join(directory, "drevo.sqlite"), {
        readOnly: true,
        allowExtension: false,
      });
      let family: Family,
        faceDescriptors: StoredFaceDescriptor[] = [],
        documents: StoredDocument[] = [],
        backupCommentsSkipped = 0,
        catalogSources: Array<CatalogSource & { version: number }> = [];
      try {
        source.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
        const tables = source
          .prepare(
            "SELECT name,type FROM sqlite_schema WHERE name IN ('archive','people','relations','photos','photo_tags')",
          )
          .all();
        if (tables.length !== 5 || tables.some((t) => t.type !== "table"))
          throw new Error("Это не база семейного архива Drevo");
        if (source.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
          throw new Error("База повреждена");
        family = validateFamily(
          (await readArchive(storeDatabase(source))).family,
        );
        if (
          source
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='person_comments'",
            )
            .get()
        )
          backupCommentsSkipped = Number(
            source
              .prepare("SELECT count(*) AS count FROM person_comments")
              .get()!.count,
          );
        if (
          source
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='documents'",
            )
            .get()
        ) {
          const people = new Set(family.people.map((person) => person.id));
          const documentColumns = new Set(
            source
              .prepare("PRAGMA table_info(documents)")
              .all()
              .map((column) => String(column.name)),
          );
          const savedColumn = (name: string, fallback: string) =>
            documentColumns.has(name) ? name : `'${fallback}' AS ${name}`;
          const rows = source
            .prepare(
              `SELECT id,title,file_name,file_size,uploaded_by,created_at,${["annotations", "event_links", "pages"].map((name) => savedColumn(name, "[]")).join(",")},${["document_type", "document_date", "place", "description", "provenance"].map((name) => savedColumn(name, "")).join(",")} FROM documents ORDER BY created_at,id`,
            )
            .all();
          const links = source
            .prepare("SELECT document_id,person_id FROM document_people")
            .all();
          const byDocument = new Map<string, string[]>();
          for (const link of links) {
            const id = String(link.document_id),
              personId = String(link.person_id);
            if (!people.has(personId))
              throw new Error("Документ ссылается на отсутствующего человека");
            byDocument.set(id, [...(byDocument.get(id) || []), personId]);
          }
          documents = rows.map((row) => {
            const document: StoredDocument = {
              id: String(row.id),
              title: String(row.title),
              fileName: String(row.file_name),
              fileSize: Number(row.file_size),
              uploadedBy: String(row.uploaded_by),
              createdAt: String(row.created_at),
              annotations: String(row.annotations || "[]"),
              eventLinks: String(row.event_links || "[]"),
              pages: String(row.pages || "[]"),
              documentType: String(row.document_type || ""),
              documentDate: String(row.document_date || ""),
              place: String(row.place || ""),
              description: String(row.description || ""),
              provenance: String(row.provenance || ""),
              personIds: byDocument.get(String(row.id)) || [],
            };
            if (
              !/^[a-f0-9-]{36}$/.test(document.id) ||
              !storedDocumentFileType(document.fileName) ||
              !document.title ||
              document.title.length > 160 ||
              !parseDocumentDetails(document) ||
              document.fileSize < 1 ||
              document.fileSize >
                (storedDocumentFileType(document.fileName)?.maxBytes || 0)
            )
              throw new Error("Некорректный документ в бэкапе");
            return document;
          });
        }
        if (
          source
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='source_catalog'",
            )
            .get()
        ) {
          const rows = source
            .prepare("SELECT id,data,version FROM source_catalog ORDER BY id")
            .all();
          if (rows.length > 50_000)
            throw new Error("Слишком много источников в бэкапе");
          catalogSources = rows.map((row) => {
            let parsed: CatalogSource | null = null;
            try {
              parsed = parseCatalogSource(JSON.parse(String(row.data)));
            } catch {
              /* Invalid catalogue data is reported before applying the backup. */
            }
            const version = Number(row.version);
            if (
              !parsed ||
              parsed.id !== row.id ||
              !Number.isSafeInteger(version) ||
              version < 1 ||
              version > 2_147_483_645
            )
              throw new Error("Некорректный источник в бэкапе");
            return { ...parsed, version };
          });
        }
        const documentIds = new Set(documents.map((document) => document.id));
        const catalog = new Map(catalogSources.map((item) => [item.id, item]));
        if (
          catalogSources.some((item) =>
            item.documentIds.some((id) => !documentIds.has(id)),
          )
        )
          throw new Error(
            "Источник в бэкапе ссылается на отсутствующий документ",
          );
        for (const citation of allCitations(family)) {
          if (citation.documentId && !documentIds.has(citation.documentId))
            throw new Error(
              "Цитата в бэкапе ссылается на отсутствующий документ",
            );
          if (
            citation.catalogId &&
            (!catalog.has(citation.catalogId) ||
              (citation.documentId &&
                !catalog
                  .get(citation.catalogId)!
                  .documentIds.includes(citation.documentId)))
          )
            throw new Error(
              "Цитата в бэкапе ссылается на отсутствующий источник или документ каталога",
            );
        }
        if (
          source
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='face_descriptors'",
            )
            .get()
        ) {
          const people = new Set(family.people.map((person) => person.id));
          const photos = new Set(
            (family.photos || []).map((photo) => photo.id),
          );
          const tags = new Map<string, { photoId: string; personId: string }>();
          const firstTagByPhotoPerson = new Map<string, string>();
          for (const photo of family.photos || [])
            for (const tag of photo.tags) {
              const id = `${photo.id}:${tag.id}`;
              tags.set(id, { photoId: photo.id, personId: tag.personId });
              const key = `${photo.id}\0${tag.personId}`;
              if (!firstTagByPhotoPerson.has(key))
                firstTagByPhotoPerson.set(key, id);
            }
          faceDescriptors = source
            .prepare("SELECT * FROM face_descriptors ORDER BY rowid")
            .all()
            .flatMap((row) => {
              let descriptor: unknown;
              try {
                descriptor = JSON.parse(String(row.data));
              } catch {
                return [];
              }
              const personId = String(row.person_id),
                sourcePhotoId = row.source_photo_id
                  ? String(row.source_photo_id)
                  : undefined,
                sourceTagId = row.source_tag_id
                  ? String(row.source_tag_id)
                  : sourcePhotoId
                    ? firstTagByPhotoPerson.get(`${sourcePhotoId}\0${personId}`)
                    : undefined,
                sourceTag = sourceTagId ? tags.get(sourceTagId) : undefined,
                model = row.model ? String(row.model) : "face-api-1.7.15",
                dimensions =
                  model === "face-api-1.7.15"
                    ? 128
                    : model === "human-faceres-3.3.6"
                      ? 1024
                      : 0;
              if (
                !people.has(personId) ||
                (sourcePhotoId && !photos.has(sourcePhotoId)) ||
                (sourcePhotoId &&
                  (!sourceTag ||
                    sourceTag.photoId !== sourcePhotoId ||
                    sourceTag.personId !== personId)) ||
                !Array.isArray(descriptor) ||
                descriptor.length !== dimensions ||
                !descriptor.every(
                  (item) => typeof item === "number" && Number.isFinite(item),
                )
              )
                return [];
              return [
                {
                  id: String(row.id),
                  personId,
                  data: JSON.stringify(descriptor),
                  createdBy: row.created_by
                    ? String(row.created_by)
                    : undefined,
                  sourcePhotoId,
                  sourceTagId,
                  model,
                },
              ];
            });
        }
      } finally {
        source.close();
      }
      const files = new Map<string, string>();
      const documentFiles = new Map<string, string>();
      for (const document of documents) {
        const archived = join(directory, "uploads", document.fileName);
        const current = join(dirname(dbPath), "uploads", document.fileName);
        const file = existsSync(archived) ? archived : current;
        if (!existsSync(file))
          throw new Error(`Нет файла документа «${document.title}»`);
        const info = await stat(file);
        if (!info.isFile() || info.size !== document.fileSize)
          throw new Error(`Повреждён документ «${document.title}»`);
        try {
          await verifyPortableMediaFile(file, document.fileName);
        } catch {
          throw new Error(`Повреждён документ «${document.title}»`);
        }
        documentFiles.set(document.id, file);
      }
      let missing = 0;
      const documentNames = new Set(
        documents.map((document) => document.fileName),
      );
      for (const url of references(family)) {
        const match = originalMediaPattern.exec(url);
        if (!match) throw new Error("Недопустимое имя оригинала в базе");
        // The document loop already verifies and stages these originals.
        if (documentNames.has(match[1])) continue;
        const file = join(directory, "uploads", match[1]);
        if (existsSync(file)) {
          await verifyPortableMediaFile(file, match[1]);
          files.set(url, file);
        } else if (!existsSync(join(dirname(dbPath), "uploads", match[1])))
          missing++;
      }
      const importedPeople = new Set(family.people.map((person) => person.id));
      const { current, currentCommentsLost } = await archive.db.transaction(
        async () => {
          const current = await readArchive(archive.db);
          const counts = await archive.db
            .prepare(
              "SELECT person_id,count(*) AS count FROM person_comments GROUP BY person_id",
              "SELECT person_id,count(*) AS count FROM person_comments GROUP BY person_id",
            )
            .all();
          return {
            current,
            currentCommentsLost: counts.reduce(
              (sum, row) =>
                sum +
                (importedPeople.has(String(row.person_id))
                  ? 0
                  : Number(row.count)),
              0,
            ),
          };
        },
        true,
      );
      const token = randomUUID();
      const stage: Stage = {
        directory,
        family,
        actor: actor.id,
        revision: current.revision,
        expires: Date.now() + 15 * 60000,
        files,
        faceDescriptors,
        documents,
        documentFiles,
        catalogSources,
      };
      await archive.db
        .prepare(
          `INSERT INTO workflow_stages(token,kind,actor_id,revision,expires_at,data,directory)
           VALUES(?,'restore',?,?,?,?,?)`,
          "INSERT INTO workflow_stages(token,kind,actor_id,revision,expires_at,data,directory)\n           VALUES(?,'restore',?,?,?,?,?)",
        )
        .run(
          token,
          actor.id,
          current.revision,
          stage.expires,
          JSON.stringify({
            family,
            files: [...files],
            faceDescriptors,
            documents,
            documentFiles: [...documentFiles],
            catalogSources,
          }),
          directory,
        );
      return {
        token,
        revision: current.revision,
        title: family.title,
        people: family.people.length,
        photos: family.photos?.length || 0,
        documents: documents.length,
        sources: catalogSources.length,
        files: files.size,
        missing,
        currentCommentsLost,
        backupCommentsSkipped,
        currentPeople: current.family.people.length,
        currentPhotos: current.family.photos?.length || 0,
      };
    } catch (error) {
      removeStage(directory, stagingRoot);
      throw error;
    } finally {
      await reservation?.release();
    }
  }

  return {
    async preview(bytes: Buffer, actor: ArchiveUser) {
      if (!bytes.length || bytes.length > RESTORE_LIMIT)
        throw new Error("Бэкап должен быть не больше 12 ГБ");
      return await previewStream(Readable.from([bytes]), actor);
    },
    previewStream,
    discard,
    async apply(
      token: string,
      actor: ArchiveUser,
      assertAccess: (transaction?: StoreDatabase) => Promise<void>,
    ) {
      const stage = await readStage(token);
      if (
        actor.role !== "admin" ||
        !stage ||
        stage.actor !== actor.id ||
        stage.expires < Date.now()
      )
        throw new Error("Проверка бэкапа истекла. Выберите файл повторно.");
      if ((await archive.read()).revision !== stage.revision)
        throw new ConflictError(
          "После проверки бэкапа архив изменился. Проверьте файл повторно перед восстановлением.",
        );
      await assertAccess();
      const backups = join(dirname(dbPath), "backups");
      mkdirSync(backups, { recursive: true });
      const backupName = `before-import-${Date.now()}-${randomUUID()}.sqlite`;
      await writeDatabaseBackup(archive.db, join(backups, backupName));
      const created: string[] = [],
        urls = new Map<string, string>();
      const restoredOriginals: Array<{ url: string; size: number }> = [];
      const restoredDocuments: StoredDocument[] = [];
      const documentIdMap = new Map<string, string>();
      let result: Awaited<ReturnType<typeof archive.write>>;
      const copySources = [
        ...stage.files.values(),
        ...stage.documentFiles.values(),
      ];
      const copyBytes = (
        await Promise.all(copySources.map((path) => stat(path)))
      ).reduce((sum, file) => sum + file.size, 0);
      if (!Number.isSafeInteger(copyBytes))
        throw new Error("Некорректный размер файлов восстановления");
      const copyReservation = copyBytes
        ? await reservePlatformDisk(archive.db, copyBytes, async () => {
            const disk = await statfs(dirname(dbPath));
            return disk.bavail * disk.bsize;
          })
        : undefined;
      try {
        for (const [url, path] of stage.files) {
          const name = `${randomUUID()}.${originalMediaPattern.exec(url)![2]}`,
            destination = join(dirname(dbPath), "uploads", name);
          await copyFile(path, destination, constants.COPYFILE_EXCL);
          created.push(destination);
          const restoredUrl = `/media/${name}`;
          urls.set(url, restoredUrl);
          restoredOriginals.push({
            url: restoredUrl,
            size: (await stat(destination)).size,
          });
        }
        for (const document of stage.documents) {
          const source = stage.documentFiles.get(document.id);
          if (!source) throw new Error("Файл документа отсутствует в бэкапе");
          const id = randomUUID(),
            fileName = `${id}.${storedDocumentFileType(document.fileName)!.extension}`,
            destination = join(dirname(dbPath), "uploads", fileName);
          await copyFile(source, destination, constants.COPYFILE_EXCL);
          created.push(destination);
          restoredDocuments.push({ ...document, id, fileName });
          documentIdMap.set(document.id, id);
          urls.set(`/media/${document.fileName}`, `/media/${fileName}`);
        }
        const remapCitation = (source: Source): Source => {
          const local = source.url && portableCitationMedia(source.url);
          const remapped = local && urls.get(`/media/${local.name}`);
          return {
            ...source,
            ...(local && remapped ? { url: remapped + local.suffix } : {}),
            ...(source.documentId
              ? { documentId: documentIdMap.get(source.documentId)! }
              : {}),
          };
        };
        const remapCitations = (sources: Source[]) =>
          sources.map(remapCitation);
        const family = structuredClone(stage.family);
        for (const person of family.people) {
          if (person.photo)
            person.photo = urls.get(person.photo) || person.photo;
          person.sources = remapCitations(person.sources);
          for (const key of [
            "birthDateClaim",
            "deathDateClaim",
            "birthPlaceClaim",
            "deathPlaceClaim",
            "occupationClaim",
            "maidenNameClaim",
          ] as const)
            if (person[key])
              person[key]!.sources = remapCitations(person[key]!.sources);
          for (const alternative of person.factAlternatives || [])
            alternative.sources = remapCitations(alternative.sources);
          for (const event of person.events || []) {
            if (event.sources) event.sources = remapCitations(event.sources);
            if (event.dateClaim)
              event.dateClaim.sources = remapCitations(event.dateClaim.sources);
            if (event.placeClaim)
              event.placeClaim.sources = remapCitations(
                event.placeClaim.sources,
              );
            for (const alternative of event.alternatives || [])
              alternative.sources = remapCitations(alternative.sources);
          }
        }
        for (const union of family.unions || []) {
          if (union.sources) union.sources = remapCitations(union.sources);
          for (const key of [
            "formation",
            "ending",
            "divorce",
            "ongoing",
          ] as const)
            if (union[key]?.sources)
              union[key]!.sources = remapCitations(union[key]!.sources!);
        }
        for (const link of family.links || [])
          if (link.sources) link.sources = remapCitations(link.sources);
        for (const photo of family.photos || [])
          photo.url = urls.get(photo.url) || photo.url;
        const restoredCatalog = stage.catalogSources.map((source) => ({
          ...source,
          documentIds: source.documentIds.map((id) => documentIdMap.get(id)!),
        }));
        result = await archive.write(
          family,
          stage.revision,
          actor,
          "Восстановление из бэкапа",
          undefined,
          stage.faceDescriptors,
          async (db) => {
            // This runs in archive.write's transaction. A platform-admin row
            // lock obtained here remains held through the archive commit.
            await assertAccess(db);
            for (const file of restoredOriginals)
              await recordMediaOriginal(db, file.url, file.size, actor.id);
            await db.exec("DELETE FROM documents", "DELETE FROM documents");
            const insert = db.prepare(
              "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,annotations,document_type,document_date,place,description,provenance,event_links,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,annotations,document_type,document_date,place,description,provenance,event_links,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            );
            const link = db.prepare(
              "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
              "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
            );
            for (const document of restoredDocuments) {
              await insert.run(
                document.id,
                document.title,
                documentSearchText(
                  document.title,
                  parseDocumentDetails(document)!,
                ),
                document.fileName,
                document.fileSize,
                document.uploadedBy,
                document.createdAt,
                document.annotations || "[]",
                document.documentType || "",
                document.documentDate || "",
                document.place || "",
                document.description || "",
                document.provenance || "",
                document.eventLinks || "[]",
                document.pages || "[]",
              );
              for (const personId of document.personIds)
                await link.run(document.id, personId);
            }
            const currentVersions = new Map(
              (
                await db
                  .prepare(
                    "SELECT id,version FROM source_catalog",
                    "SELECT id,version FROM source_catalog",
                  )
                  .all()
              ).map((row) => [String(row.id), Number(row.version)]),
            );
            await db.exec(
              "DELETE FROM source_catalog",
              "DELETE FROM source_catalog",
            );
            for (const { version, ...source } of restoredCatalog) {
              const nextVersion =
                Math.max(version, currentVersions.get(source.id) || 0) + 1;
              if (nextVersion > 2_147_483_646)
                throw new Error("Версия источника превышает допустимый предел");
              await sourceCatalogStore(db).insert(source, nextVersion);
            }
            await enforcePostgresMediaQuota(db);
          },
        );
      } catch (error) {
        await Promise.allSettled(
          created.map((path) => rm(path, { force: true })),
        );
        throw error;
      } finally {
        await copyReservation?.release();
      }
      // Ошибка уборки временного каталога не должна удалять уже сохранённые фото.
      try {
        await discard(token);
      } catch {
        await archive.db
          .prepare(
            "DELETE FROM workflow_stages WHERE kind='restore' AND token=?",
            "DELETE FROM workflow_stages WHERE kind='restore' AND token=?",
          )
          .run(token);
      }
      return { ...result, backupName };
    },
    async close() {
      clearInterval(cleanup);
      await cleaning;
    },
  };
}

export type RestoreStore = ReturnType<typeof restoreStore>;
