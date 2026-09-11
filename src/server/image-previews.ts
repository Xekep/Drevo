import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ImagePreviewVariant = "thumb" | "display";

export const IMAGE_PREVIEW_SETTINGS = {
  thumb: { maxSize: 400, quality: 76 },
  display: { maxSize: 1600, quality: 82 },
} as const satisfies Record<
  ImagePreviewVariant,
  { maxSize: number; quality: number }
>;

export const IMAGE_PREVIEW_CACHE_VERSION = 2;

export function imagePreviews(directory: string) {
  const pending = new Map<string, Promise<Buffer>>();
  let tail = Promise.resolve();
  return (original: Buffer, variant: ImagePreviewVariant) => {
    const settings = IMAGE_PREVIEW_SETTINGS[variant];
    const key = `${createHash("sha256").update(original).digest("hex")}-${variant}-v${IMAGE_PREVIEW_CACHE_VERSION}.webp`;
    if (pending.has(key)) return pending.get(key)!;
    const run = (async () => {
      try {
        return await readFile(join(directory, key));
      } catch {
        /* Ещё не создано. */
      }
      const result = tail.then(async () => {
        const input = sharp(original, { limitInputPixels: 50_000_000 });
        if (((await input.metadata()).pages || 1) > 1)
          throw new Error("Для анимации используется оригинал");
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
