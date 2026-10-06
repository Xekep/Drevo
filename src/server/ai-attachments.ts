import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, open } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { imageExtension } from "./media.ts";
import {
  AI_ATTACHMENT_BYTES,
  AI_ATTACHMENT_COUNT,
  AI_ATTACHMENTS_BYTES,
  attachmentSelectionError,
  type ResearchAttachment,
} from "../shared/research-attachments.ts";
import type { aiChatStore } from "./ai-chats.ts";

const uuid = /^[a-f0-9-]{36}$/i;
const fileRoute = /^\/api\/ai\/attachments\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/i;
const types: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  ged: "text/plain",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export type PreparedAttachment = { name: string; type: string; bytes: Buffer };

export async function validateAttachments(
  input: unknown,
  capabilities: { photoAnalysis: boolean; codeInterpreter: boolean },
): Promise<PreparedAttachment[]> {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > AI_ATTACHMENT_COUNT)
    throw new RangeError("Можно прикрепить не больше 3 файлов.");
  const files: PreparedAttachment[] = [];
  let total = 0;
  for (const item of input) {
    if (
      !item ||
      typeof item.name !== "string" ||
      item.name.length > 255 ||
      typeof item.data !== "string" ||
      item.data.length > Math.ceil(AI_ATTACHMENT_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
    )
      throw new RangeError("Некорректное вложение.");
    const name = Array.from(item.name as string)
      .map((character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        (character.length === 1 &&
          character.charCodeAt(0) >= 0xd800 &&
          character.charCodeAt(0) <= 0xdfff) ||
        character === "/" ||
        character === "\\"
          ? "_"
          : character,
      )
      .slice(-160)
      .join("");
    const bytes = Buffer.from(item.data, "base64");
    if (bytes.toString("base64") !== item.data)
      throw new RangeError("Некорректное вложение.");
    total += bytes.length;
    const error = attachmentSelectionError([{ name, size: bytes.length }]);
    if (error) throw new RangeError(error);
    if (total > AI_ATTACHMENTS_BYTES)
      throw new RangeError("Общий размер вложений — не больше 10 МБ.");
    const type = types[name.split(".").at(-1)!.toLowerCase()];
    if (type.startsWith("image/")) {
      if (!capabilities.photoAnalysis)
        throw new RangeError("Анализ фотографий отключён для вашей роли.");
      try {
        const extension = imageExtension(bytes);
        if (type !== `image/${extension === "jpg" ? "jpeg" : extension}`)
          throw new Error("format");
        const meta = await sharp(bytes, {
          limitInputPixels: 40_000_000,
        }).metadata();
        const expected = type === "image/jpeg" ? "jpeg" : type.slice(6);
        if (meta.format !== expected) throw new Error("format");
      } catch {
        throw new RangeError(
          "Изображение повреждено или не соответствует формату.",
        );
      }
    } else if (type === "application/pdf") {
      if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
        throw new RangeError("Файл не является PDF.");
    } else if (name.toLowerCase().endsWith(".xlsx")) {
      if (!capabilities.codeInterpreter)
        throw new RangeError(
          "Для XLSX администратор должен включить Code Interpreter.",
        );
      if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
        throw new RangeError("Файл не является XLSX.");
    } else {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes("\0")) throw new Error("binary");
      } catch {
        throw new RangeError("Текстовые файлы должны быть в кодировке UTF-8.");
      }
    }
    files.push({ name, type, bytes });
  }
  return files;
}

/** Private files share the archive's backed-up uploads volume, never /media URLs. */
export function aiAttachmentStore(
  uploadsDirectory: string,
  chats: ReturnType<typeof aiChatStore>,
) {
  const root = join(uploadsDirectory, "ai-chat-files");
  function directory(chatId: string) {
    if (!uuid.test(chatId)) throw new Error("Invalid chat ID");
    return join(root, chatId);
  }
  return {
    async save(
      chatId: string,
      files: PreparedAttachment[],
    ): Promise<ResearchAttachment[]> {
      if (!files.length) return [];
      const folder = directory(chatId);
      await mkdir(folder, { recursive: true });
      const saved: ResearchAttachment[] = [];
      try {
        for (const file of files) {
          const id = randomUUID();
          const handle = await open(join(folder, id), "wx", 0o600);
          saved.push({
            name: file.name,
            type: file.type,
            size: file.bytes.length,
            url: `/api/ai/attachments/${chatId}/${id}`,
          });
          try {
            await handle.writeFile(file.bytes);
          } finally {
            await handle.close();
          }
        }
        return saved;
      } catch (error) {
        await this.removeFiles(saved);
        throw error;
      }
    },
    async removeFiles(files: ResearchAttachment[]) {
      for (const file of files) {
        const match = fileRoute.exec(file.url);
        if (match)
          await rm(join(directory(match[1]), match[2]), { force: true });
      }
    },
    async read(chatId: string, file: ResearchAttachment) {
      const match = fileRoute.exec(file.url);
      if (!match || match[1] !== chatId)
        throw new Error("Недоступное вложение");
      const path = join(directory(chatId), match[2]);
      if ((await stat(path)).size > AI_ATTACHMENT_BYTES)
        throw new RangeError("Вложение слишком большое");
      return await readFile(path);
    },
    async deleteChat(chatId: string) {
      await rm(directory(chatId), { recursive: true, force: true });
    },
    async download(chatId: string, userId: string, url: string) {
      const messages = await chats.messages(chatId, userId);
      const file = messages
        ?.flatMap((message) => message.attachments || [])
        .find((file) => file.url === url);
      return file ? { file, bytes: await this.read(chatId, file) } : null;
    },
    async prune() {
      // Account deletion cascades chat rows. Remove orphan folders on startup.
      for (const entry of await readdir(root, { withFileTypes: true }).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        },
      )) {
        if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
        const folder = directory(entry.name);
        if (Date.now() - (await stat(folder)).mtimeMs < 86_400_000) continue;
        if (!(await chats.exists(entry.name)))
          await rm(folder, { recursive: true, force: true });
      }
    },
  };
}
