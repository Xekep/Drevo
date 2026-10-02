import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ImagePreviewVariant = "tiny" | "thumb" | "display" | "ai";
export type ImagePreviewSource = Buffer | { path: string; cacheKey: string };

export const IMAGE_PREVIEW_SETTINGS = {
  tiny: { maxSize: 48, quality: 45 },
  thumb: { maxSize: 400, quality: 76 },
  display: { maxSize: 1600, quality: 82 },
  ai: { maxSize: 1600, quality: 86 },
} as const satisfies Record<
  ImagePreviewVariant,
  { maxSize: number; quality: number }
>;

export const IMAGE_PREVIEW_CACHE_VERSION = 3;
const MAX_PENDING_PREVIEWS = 32;

export function imagePreviews(directory: string) {
  const pending = new Map<string, Promise<Buffer>>();
  let tail = Promise.resolve();
  return (original: ImagePreviewSource, variant: ImagePreviewVariant) => {
    const settings = IMAGE_PREVIEW_SETTINGS[variant];
    const sourceKey = Buffer.isBuffer(original)
      ? createHash("sha256").update(original).digest("hex")
      : `file-${original.cacheKey}`;
    const extension = variant === "ai" ? "jpg" : "webp";
    const key = `${sourceKey}-${variant}-v${IMAGE_PREVIEW_CACHE_VERSION}.${extension}`;
    if (pending.has(key)) return pending.get(key)!;
    if (pending.size >= MAX_PENDING_PREVIEWS)
      return Promise.reject(
        new Error("Очередь подготовки фотографий заполнена"),
      );
    const run = (async () => {
      try {
        return await readFile(join(directory, key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const result = tail.then(async () => {
        const source = Buffer.isBuffer(original)
          ? original
          : await readFile(original.path);
        const input = sharp(source, { limitInputPixels: 50_000_000 });
        const metadata = await input.metadata();
        if ((metadata.pages || 1) > 1)
          throw new Error("Для анимации используется оригинал");
        // Для крошечных иконок lossy WebP бессмысленен: экономия ничтожна,
        // а цвет может сдвинуться даже на однотонном изображении. Обычные
        // фотографии остаются lossy и используют quality варианта.
        const tiny =
          (metadata.width || 0) <= 32 && (metadata.height || 0) <= 32;
        const resized = input
          .rotate()
          .resize({
            width: settings.maxSize,
            height: settings.maxSize,
            fit: "inside",
            withoutEnlargement: true,
          });
        const output = variant === "tiny"
          ? resized.grayscale()
          : resized.keepIccProfile();
        const bytes = await (
          variant === "ai"
            ? output.jpeg({ quality: settings.quality, mozjpeg: true })
            : output.webp({
                quality: settings.quality,
                lossless: tiny,
                effort: 4,
                smartSubsample: true,
              })
        ).toBuffer();
        await mkdir(directory, { recursive: true });
        // Two backend processes share this directory. Never make a partial
        // preview visible under its final cache key.
        const destination = join(directory, key);
        const temporary = join(directory, `.${key}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, bytes, { flag: "wx" });
          try {
            await rename(temporary, destination);
          } catch (error) {
            // Windows may refuse to replace a preview opened by a reader.
            // A peer's complete publication is an equally valid result.
            if (!["EEXIST", "EPERM", "EACCES"].includes(
              (error as NodeJS.ErrnoException).code || "")) throw error;
            let published: Buffer;
            try {
              published = await readFile(destination);
            } catch {
              throw error;
            }
            if (!published.equals(bytes)) throw error;
          }
        } finally {
          await rm(temporary, { force: true });
        }
        return bytes;
      });
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    })().finally(() => pending.delete(key));
    pending.set(key, run);
    return run;
  };
}
