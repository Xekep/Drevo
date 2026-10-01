import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  MAX_COMMENT_FILES,
  MAX_COMMENT_FILE_BYTES,
  MAX_COMMENT_FILES_BYTES,
  commentFileId,
  validCommentFiles,
  validCommentFileName,
  type CommentAttachmentFile,
} from "../shared/person-discussion.ts";

const types: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  ged: "text/plain",
  zip: "application/zip",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export type PreparedCommentFile = {
  name: string;
  type: string;
  bytes: Buffer;
  preview?: Buffer;
};

export async function prepareCommentFile(
  name: string,
  bytes: Buffer,
): Promise<PreparedCommentFile> {
  if (
    !validCommentFileName(name) ||
    !bytes.length ||
    bytes.length > MAX_COMMENT_FILE_BYTES
  )
    throw new RangeError("Некорректный файл. Максимальный размер — 10 МБ.");
  const type = types[name.split(".").at(-1)!.toLowerCase()];
  if (!type) throw new RangeError("Этот формат файла не поддерживается.");
  let preview: Buffer | undefined;
  if (type.startsWith("image/")) {
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      if (metadata.format !== (type === "image/jpeg" ? "jpeg" : type.slice(6)))
        throw new Error("format");
      preview = await image
        .rotate()
        .resize(480, 480, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 74 })
        .toBuffer();
    } catch {
      throw new RangeError(
        "Изображение повреждено или не соответствует формату.",
      );
    }
  } else if (type === "application/pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new RangeError("Файл не является PDF.");
  } else if (
    ["zip", "docx", "xlsx"].includes(name.split(".").at(-1)!.toLowerCase())
  ) {
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
      throw new RangeError("Файл не соответствует формату архива.");
  } else if (["doc", "xls"].includes(name.split(".").at(-1)!.toLowerCase())) {
    if (!bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")))
      throw new RangeError("Файл не соответствует формату Office.");
  } else {
    try {
      if (
        new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0")
      )
        throw new Error("binary");
    } catch {
      throw new RangeError("Текстовые файлы должны быть в кодировке UTF-8.");
    }
  }
  return { name, type, bytes, preview };
}

export async function prepareCommentAttachments(input: unknown) {
  if (input === undefined) return null;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new RangeError("Некорректные вложения.");
  const { keep, files } = input as { keep?: unknown; files?: unknown };
  if (
    !Array.isArray(keep) ||
    !keep.every((id) => typeof id === "string" && commentFileId.test(id)) ||
    new Set(keep).size !== keep.length ||
    !Array.isArray(files) ||
    keep.length + files.length > MAX_COMMENT_FILES
  )
    throw new RangeError("Можно прикрепить не больше 8 файлов.");
  let total = 0;
  const prepared: PreparedCommentFile[] = [];
  for (const file of files) {
    if (
      !file ||
      typeof file.name !== "string" ||
      typeof file.data !== "string" ||
      file.data.length > Math.ceil(MAX_COMMENT_FILE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
    )
      throw new RangeError("Некорректное вложение.");
    const bytes = Buffer.from(file.data, "base64");
    total += bytes.length;
    if (
      bytes.toString("base64") !== file.data ||
      total > MAX_COMMENT_FILES_BYTES
    )
      throw new RangeError("Общий размер вложений — не больше 20 МБ.");
    prepared.push(await prepareCommentFile(file.name, bytes));
  }
  return { keep: keep as string[], files: prepared };
}

export function commentFilesFromJson(json: unknown): CommentAttachmentFile[] {
  const value: unknown = typeof json === "string" ? JSON.parse(json) : json;
  if (!validCommentFiles(value))
    throw new Error("Некорректные метаданные вложений.");
  return value;
}

export function discussionAttachmentStore(uploads: string) {
  const root = join(uploads, "discussion-files");
  function path(id: string, preview = false) {
    if (!commentFileId.test(id)) throw new Error("Некорректное вложение");
    return join(root, id + (preview ? ".webp" : ""));
  }
  async function remove(files: CommentAttachmentFile[]) {
    await Promise.all(
      files.flatMap((file) => [
        rm(path(file.id), { force: true }),
        rm(path(file.id, true), { force: true }),
      ]),
    );
  }
  return {
    remove,
    async save(files: PreparedCommentFile[]) {
      const saved: CommentAttachmentFile[] = [];
      if (!files.length) return saved;
      await mkdir(root, { recursive: true });
      try {
        for (const file of files) {
          const entry = {
            id: randomUUID(),
            name: file.name,
            type: file.type,
            size: file.bytes.length,
          };
          saved.push(entry);
          for (const [preview, bytes] of [
            [false, file.bytes],
            [true, file.preview],
          ] as const) {
            if (!bytes) continue;
            const handle = await open(path(entry.id, preview), "wx", 0o600);
            try {
              await handle.writeFile(bytes);
            } finally {
              await handle.close();
            }
          }
        }
        return saved;
      } catch (error) {
        await remove(saved);
        throw error;
      }
    },
    async read(file: CommentAttachmentFile, preview: boolean) {
      const bytes = await readFile(path(file.id, preview));
      if (
        bytes.length > MAX_COMMENT_FILE_BYTES ||
        (!preview && bytes.length !== file.size)
      )
        throw new Error("Размер вложения изменился");
      return bytes;
    },
  };
}
