import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ImagePreviewVariant = "thumb" | "display";
export type ImagePreviewSource =
  | Buffer
  | { path: string; cacheKey: string };

export const IMAGE_PREVIEW_SETTINGS = {
  thumb: { maxSize: 400, quality: 76 },
  display: { maxSize: 1600, quality: 82 },
} as const satisfies Record<
  ImagePreviewVariant,
  { maxSize: number; quality: number }
>;

export const IMAGE_PREVIEW_CACHE_VERSION = 2;
const MAX_PENDING_PREVIEWS = 32;

export function imagePreviews(directory: string) {
  const pending = new Map<string, Promise<Buffer>>();
  let tail = Promise.resolve();
  return (original: ImagePreviewSource, variant: ImagePreviewVariant) => {
    const settings = IMAGE_PREVIEW_SETTINGS[variant];
    const sourceKey = Buffer.isBuffer(original)
      ? createHash("sha256").update(original).digest("hex")
      : `file-${original.cacheKey}`;
    const key = `${sourceKey}-${variant}-v${IMAGE_PREVIEW_CACHE_VERSION}.webp`;
    if (pending.has(key)) return pending.get(key)!;
    if (pending.size >= MAX_PENDING_PREVIEWS)
      return Promise.reject(new Error("Очередь подготовки фотографий заполнена"));
    const run = (async () => {
      try {
        return await readFile(join(directory, key));
      } catch {
        /* Ещё не создано. */
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
        const bytes = await input
          .rotate()
          .resize({
            width: settings.maxSize,
            height: settings.maxSize,
            fit: "inside",
            withoutEnlargement: true,
          })
          .keepIccProfile()
          .webp({
            quality: settings.quality,
            lossless: tiny,
            effort: 4,
            smartSubsample: true,
          })
          .toBuffer();
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, key), bytes);
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
