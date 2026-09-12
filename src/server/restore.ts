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
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import {
  copyFile,
  open as openFile,
  rename,
  rm,
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
import { imageExtension, mediaPattern } from "./media.ts";
import { validateFamily, type Family } from "../domain/index.ts";
import type { ArchiveUser } from "../domain/access.ts";

const RESTORE_LIMIT = 12 * 1024 * 1024 * 1024;
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
const references = (family: Family) => [
  ...new Set(
    [
      ...family.people.map((p) => p.photo),
      ...(family.photos || []).map((p) => p.url),
    ].filter((url): url is string => !!url && url.startsWith("/media/")),
  ),
];

async function streamUpload(source: Readable, file: string) {
  let size = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > RESTORE_LIMIT) {
        callback(new RestoreTooLargeError("Файл слишком большой. Максимум 12 ГиБ."));
        return;
      }
      callback(null, bytes);
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

function imageExtensionFile(file: string) {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(16),
      bytesRead = readSync(fd, header, 0, header.length, 0);
    return imageExtension(header.subarray(0, bytesRead));
  } finally {
    closeSync(fd);
  }
}

/** Читаем только ожидаемые файлы собственного бэкапа; ссылки и пути наружу запрещены. */
async function unpack(source: Readable, directory: string) {
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
          if (++files > 10000) throw new Error("В бэкапе слишком много файлов");
          if (pax) {
            if (remaining > 65536)
              throw new Error("Слишком большой заголовок TAR");
          } else if (type === "5" && name === "uploads/" && remaining === 0)
            name = "";
          else {
            if (type !== "0" && type !== "")
              throw new Error("В бэкапе допустимы только обычные файлы");
            if (
              name !== "drevo.sqlite" &&
              !/^uploads\/[a-zA-Z0-9-]+\.(jpg|png|webp|gif)$/.test(name)
            )
              throw new Error("Недопустимый путь в бэкапе");
            if (
              remaining >
              (name === "drevo.sqlite" ? SQLITE_LIMIT : 20 * 1024 * 1024)
            )
              throw new Error("Один из файлов бэкапа слишком большой");
            if (seen.has(name))
              throw new Error("Повторяющееся имя файла в бэкапе");
            seen.add(name);
            entryFd = openSync(join(directory, name), "wx", 0o600);
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
};

function createRestoreStore(
  archive: ReturnType<typeof openArchive>,
  dbPath: string,
) {
  const stagingRoot = join(dirname(dbPath), "staging");
  mkdirSync(stagingRoot, { recursive: true });
  const readStage = (token: string): Stage | undefined => {
    const row = archive.db
      .prepare(
        "SELECT actor_id,revision,expires_at,data,directory FROM workflow_stages WHERE kind='restore' AND token=?",
      )
      .get(token);
    if (!row) return undefined;
    const data = JSON.parse(String(row.data)) as {
      family: Family;
      files: [string, string][];
      faceDescriptors: StoredFaceDescriptor[];
    };
    return {
      directory: String(row.directory),
      family: data.family,
      actor: String(row.actor_id),
      revision: Number(row.revision),
      expires: Number(row.expires_at),
      files: new Map(data.files),
      faceDescriptors: data.faceDescriptors,
    };
  };
  const discard = (token: string) => {
    const stage = readStage(token);
    if (stage) removeStage(stage.directory, stagingRoot);
    archive.db
      .prepare("DELETE FROM workflow_stages WHERE kind='restore' AND token=?")
      .run(token);
  };
  const cleanup = setInterval(() => {
    const expired = archive.db
      .prepare(
        "SELECT token FROM workflow_stages WHERE kind='restore' AND expires_at<?",
      )
      .all(Date.now());
    for (const row of expired) discard(String(row.token));
  }, 60000);
  cleanup.unref();

  async function previewStream(
    sourceStream: Readable,
    actor: ArchiveUser,
    assertAccess?: () => void,
  ) {
    if (actor.role !== "admin")
      throw new Error("Восстановление доступно администратору");
    const obsolete = archive.db
      .prepare(
        "SELECT token FROM workflow_stages WHERE kind='restore' AND (actor_id=? OR expires_at<?)",
      )
      .all(actor.id, Date.now());
    for (const row of obsolete) discard(String(row.token));
    const active = Number(
      archive.db
        .prepare("SELECT count(*) AS count FROM workflow_stages WHERE kind='restore'")
        .get()!.count,
    );
    if (active >= 3)
      throw new Error("Уже проверяется несколько бэкапов. Повторите позже.");

    const directory = mkdtempSync(join(stagingRoot, "restore-")),
      upload = join(directory, ".upload");
    mkdirSync(join(directory, "uploads"));
    try {
      const size = await streamUpload(sourceStream, upload);
      assertAccess?.();
      const header = await fileHeader(upload);
      if (header.toString("binary") === "SQLite format 3\0") {
        if (size > SQLITE_LIMIT) throw new Error("База больше 512 МБ");
        await rename(upload, join(directory, "drevo.sqlite"));
      } else if (header[0] === 31 && header[1] === 139) {
        await unpack(createReadStream(upload), directory);
        await unlink(upload);
      } else throw new Error("Выберите бэкап Drevo: .sqlite или .tar.gz");

      const source = new DatabaseSync(join(directory, "drevo.sqlite"), {
        readOnly: true,
        allowExtension: false,
      });
      let family: Family, faceDescriptors: StoredFaceDescriptor[] = [];
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
        family = validateFamily(readArchive(source).family);
        if (
          source.prepare(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='face_descriptors'",
          ).get()
        ) {
          const people = new Set(family.people.map((person) => person.id));
          const photos = new Set((family.photos || []).map((photo) => photo.id));
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
                !Array.isArray(descriptor) ||
                descriptor.length !== dimensions ||
                !descriptor.every(
                  (item) => typeof item === "number" && Number.isFinite(item),
                )
              )
                return [];
              return [{
                id: String(row.id),
                personId,
                data: JSON.stringify(descriptor),
                createdBy: row.created_by ? String(row.created_by) : undefined,
                sourcePhotoId,
                model,
              }];
            });
        }
      } finally {
        source.close();
      }
      const files = new Map<string, string>();
      let missing = 0;
      for (const url of references(family)) {
        const match = mediaPattern.exec(url);
        if (!match) throw new Error("Недопустимое имя фотографии в базе");
        const file = join(directory, "uploads", match[1]);
        if (existsSync(file)) {
          if (imageExtensionFile(file) !== match[2])
            throw new Error(
              "Содержимое фотографии не соответствует расширению",
            );
          files.set(url, file);
        } else if (!existsSync(join(dirname(dbPath), "uploads", match[1])))
          missing++;
      }
      const token = randomUUID(),
        current = archive.read();
      const stage: Stage = {
        directory,
        family,
        actor: actor.id,
        revision: current.revision,
        expires: Date.now() + 15 * 60000,
        files,
        faceDescriptors,
      };
      archive.db
        .prepare(
          `INSERT INTO workflow_stages(token,kind,actor_id,revision,expires_at,data,directory)
           VALUES(?,'restore',?,?,?,?,?)`,
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
          }),
          directory,
        );
      return {
        token,
        revision: current.revision,
        title: family.title,
        people: family.people.length,
        photos: family.photos?.length || 0,
        files: files.size,
        missing,
        currentPeople: current.family.people.length,
        currentPhotos: current.family.photos?.length || 0,
      };
    } catch (error) {
      removeStage(directory, stagingRoot);
      throw error;
    }
  }

  return {
    async preview(bytes: Buffer, actor: ArchiveUser) {
      if (!bytes.length || bytes.length > RESTORE_LIMIT)
        throw new Error("Бэкап должен быть не больше 12 ГБ");
      return previewStream(Readable.from([bytes]), actor);
    },
    previewStream,
    discard,
    async apply(token: string, actor: ArchiveUser) {
      const stage = readStage(token);
      if (
        actor.role !== "admin" ||
        !stage ||
        stage.actor !== actor.id ||
        stage.expires < Date.now()
      )
        throw new Error("Проверка бэкапа истекла. Выберите файл повторно.");
      if (archive.read().revision !== stage.revision)
        throw new ConflictError(
          "После проверки бэкапа архив изменился. Проверьте файл повторно перед восстановлением.",
        );
      const backups = join(dirname(dbPath), "backups");
      mkdirSync(backups, { recursive: true });
      const backupName = `before-import-${Date.now()}-${randomUUID()}.sqlite`;
      writeDatabaseBackup(archive.db, join(backups, backupName));
      const created: string[] = [],
        urls = new Map<string, string>();
      let result: ReturnType<typeof archive.write>;
      try {
        for (const [url, path] of stage.files) {
          const name = `${randomUUID()}.${imageExtensionFile(path)}`,
            destination = join(dirname(dbPath), "uploads", name);
          await copyFile(path, destination, constants.COPYFILE_EXCL);
          created.push(destination);
          urls.set(url, `/media/${name}`);
        }
        const family = {
          ...stage.family,
          people: stage.family.people.map((p) => ({
            ...p,
            ...(p.photo ? { photo: urls.get(p.photo) || p.photo } : {}),
          })),
          photos: stage.family.photos?.map((p) => ({
            ...p,
            url: urls.get(p.url) || p.url,
          })),
        };
        result = archive.write(
          family,
          stage.revision,
          actor,
          "Восстановление из бэкапа",
          undefined,
          stage.faceDescriptors,
        );
      } catch (error) {
        await Promise.allSettled(
          created.map((path) => rm(path, { force: true })),
        );
        throw error;
      }
      // Ошибка уборки временного каталога не должна удалять уже сохранённые фото.
      try {
        discard(token);
      } catch {
        archive.db
          .prepare("DELETE FROM workflow_stages WHERE kind='restore' AND token=?")
          .run(token);
      }
      return { ...result, backupName };
    },
    close() {
      clearInterval(cleanup);
    },
  };
}

export type RestoreStore = ReturnType<typeof createRestoreStore>;
const restoreStores = new WeakMap<
  ReturnType<typeof openArchive>,
  RestoreStore
>();

export function restoreStore(
  archive: ReturnType<typeof openArchive>,
  dbPath: string,
) {
  const store = createRestoreStore(archive, dbPath);
  restoreStores.set(archive, store);
  return store;
}

export function currentRestoreStore(archive: ReturnType<typeof openArchive>) {
  const store = restoreStores.get(archive);
  if (!store) throw new Error("Хранилище восстановления не инициализировано");
  return store;
}
