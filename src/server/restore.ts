import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readArchive, ConflictError, type openArchive } from "./database.ts";
import { databaseBackup } from "./backup.ts";
import { imageExtension, mediaPattern } from "./media.ts";
import { validateFamily, type Family } from "../domain/index.ts";
import type { ArchiveUser } from "../domain/access.ts";

export const RESTORE_LIMIT = 128 * 1024 * 1024;
function removeStage(directory: string) {
  const path = resolve(directory);
  if (
    dirname(path) !== resolve(tmpdir()) ||
    !basename(path).startsWith("drevo-restore-")
  )
    throw new Error("Недопустимый временный каталог");
  rmSync(path, { recursive: true, force: true });
}
const SQLITE_LIMIT = 32 * 1024 * 1024,
  UNPACKED_LIMIT = 512 * 1024 * 1024;
const references = (family: Family) => [
  ...new Set(
    [
      ...family.people.map((p) => p.photo),
      ...(family.photos || []).map((p) => p.url),
    ].filter((url): url is string => !!url && url.startsWith("/media/")),
  ),
];

/** Читаем только ожидаемые файлы собственного бэкапа; ссылки и пути наружу запрещены. */
async function unpack(bytes: Buffer, directory: string) {
  const stream = Readable.from([bytes]).pipe(createGunzip());
  let pending = Buffer.alloc(0),
    total = 0,
    remaining = 0,
    padding = 0,
    name = "",
    content: Buffer[] = [],
    files = 0;
  let pax = false,
    nextPath: string | undefined;
  const seen = new Set<string>();
  function finish() {
    const data = Buffer.concat(content);
    if (pax) {
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
    } else if (name) {
      if (seen.has(name)) throw new Error("Повторяющееся имя файла в бэкапе");
      seen.add(name);
      writeFileSync(join(directory, name), data, { flag: "wx", mode: 0o600 });
    }
    content = [];
    name = "";
    pax = false;
  }
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > UNPACKED_LIMIT)
      throw new Error("Распакованный бэкап больше 512 МБ");
    pending = Buffer.concat([pending, chunk]);
    while (pending.length) {
      if (remaining) {
        const take = Math.min(remaining, pending.length);
        content.push(Buffer.from(pending.subarray(0, take)));
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
        }
        if (!remaining) finish();
      }
    }
  }
  if (remaining || padding || pending.length) throw new Error("Бэкап оборван");
}

type Stage = {
  directory: string;
  family: Family;
  actor: string;
  revision: number;
  expires: number;
  files: Map<string, string>;
};
export function restoreStore(
  archive: ReturnType<typeof openArchive>,
  dbPath: string,
) {
  const stages = new Map<string, Stage>();
  const discard = (token: string) => {
    const stage = stages.get(token);
    if (stage) removeStage(stage.directory);
    stages.delete(token);
  };
  const cleanup = setInterval(() => {
    for (const [token, stage] of stages)
      if (stage.expires < Date.now()) discard(token);
  }, 60000);
  cleanup.unref();
  return {
    async preview(bytes: Buffer, actor: ArchiveUser) {
      if (actor.role !== "admin")
        throw new Error("Восстановление доступно администратору");
      if (!bytes.length || bytes.length > RESTORE_LIMIT)
        throw new Error("Бэкап должен быть не больше 128 МБ");
      for (const [token, stage] of stages)
        if (stage.actor === actor.id || stage.expires < Date.now())
          discard(token);
      if (stages.size >= 3)
        throw new Error("Уже проверяется несколько бэкапов. Повторите позже.");
      const directory = mkdtempSync(join(tmpdir(), "drevo-restore-"));
      mkdirSync(join(directory, "uploads"));
      try {
        if (bytes.subarray(0, 16).toString("binary") === "SQLite format 3\0") {
          if (bytes.length > SQLITE_LIMIT) throw new Error("База больше 32 МБ");
          writeFileSync(join(directory, "drevo.sqlite"), bytes, {
            mode: 0o600,
          });
        } else if (bytes[0] === 31 && bytes[1] === 139)
          await unpack(bytes, directory);
        else throw new Error("Выберите бэкап Drevo: .sqlite или .tar.gz");
        const source = new DatabaseSync(join(directory, "drevo.sqlite"), {
          readOnly: true,
          allowExtension: false,
        });
        let family: Family;
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
            if (imageExtension(readFileSync(file)) !== match[2])
              throw new Error(
                "Содержимое фотографии не соответствует расширению",
              );
            files.set(url, file);
          } else if (!existsSync(join(dirname(dbPath), "uploads", match[1])))
            missing++;
        }
        const token = randomUUID(),
          current = archive.read();
        stages.set(token, {
          directory,
          family,
          actor: actor.id,
          revision: current.revision,
          expires: Date.now() + 15 * 60000,
          files,
        });
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
        removeStage(directory);
        throw error;
      }
    },
    apply(token: string, actor: ArchiveUser) {
      const stage = stages.get(token);
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
      writeFileSync(join(backups, backupName), databaseBackup(archive.db), {
        flag: "wx",
        mode: 0o600,
      });
      const created: string[] = [],
        urls = new Map<string, string>();
      let result: ReturnType<typeof archive.write>;
      try {
        for (const [url, path] of stage.files) {
          const bytes = readFileSync(path),
            name = `${randomUUID()}.${imageExtension(bytes)}`,
            destination = join(dirname(dbPath), "uploads", name);
          writeFileSync(destination, bytes, { flag: "wx" });
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
        );
      } catch (error) {
        for (const path of created) rmSync(path, { force: true });
        throw error;
      }
      // Ошибка уборки временного каталога не должна удалять уже сохранённые фото.
      try {
        discard(token);
      } catch {
        stages.delete(token);
      }
      return { ...result, backupName };
    },
    close() {
      clearInterval(cleanup);
      for (const token of stages.keys()) discard(token);
    },
  };
}
