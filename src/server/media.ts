import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
export const mediaPattern = /^\/media\/([a-zA-Z0-9-]+\.(jpg|png|webp|gif))$/;
export const mimeTypes: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};
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
    add(bytes: Buffer) {
      const ext = imageExtension(bytes),
        id = randomUUID(),
        name = `${id}.${ext}`;
      writeFileSync(resolve(directory, name), bytes, { flag: "wx" });
      return {
        id,
        url: `/media/${name}`,
        undo: () => unlinkSync(resolve(directory, name)),
      };
    },
    open,
    read(url: string) {
      const file = open(url);
      if (!file) return null;
      try {
        return {
          bytes: readFileSync(file.path),
          type: file.type,
        };
      } catch {
        return null;
      }
    },
  };
}
