import {
  createWriteStream,
  mkdirSync,
} from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

export const mediaPattern = /^\/media\/([a-zA-Z0-9-]+\.(jpg|png|webp|gif))$/;
export const mimeTypes: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

export class MediaTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Максимальный размер — ${limit / 1024 / 1024} МБ`);
    this.limit = limit;
  }
}

export function imageExtension(bytes: Buffer) {
  if (bytes.length < 12) throw new Error("Файл не является фотографией");
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "jpg";
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)))
    return "gif";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  throw new Error("Поддерживаются только JPEG, PNG, WebP и GIF");
}

export function mediaStore(directory: string) {
  mkdirSync(directory, { recursive: true });
  const open = (url: string) => {
    const match = mediaPattern.exec(url);
    if (!match) return null;
    return {
      name: match[1],
      path: resolve(directory, match[1]),
      type: mimeTypes[match[2]],
    };
  };
  return {
    async addStream(source: Readable, limit: number) {
      const id = randomUUID(),
        temporary = resolve(directory, `.${id}.upload`),
        headerParts: Buffer[] = [];
      let headerLength = 0,
        size = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > limit) {
            callback(new MediaTooLargeError(limit));
            return;
          }
          if (headerLength < 12) {
            const part = bytes.subarray(0, 12 - headerLength);
            headerParts.push(part);
            headerLength += part.length;
          }
          callback(null, bytes);
        },
      });
      try {
        await pipeline(
          source,
          guard,
          createWriteStream(temporary, { flags: "wx" }),
        );
        const ext = imageExtension(Buffer.concat(headerParts, headerLength)),
          name = `${id}.${ext}`,
          target = resolve(directory, name);
        await rename(temporary, target);
        return {
          id,
          url: `/media/${name}`,
          undo: () => unlink(target).catch(() => {}),
        };
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
    open,
  };
}
