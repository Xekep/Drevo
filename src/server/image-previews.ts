import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function imagePreviews(directory: string) {
  const pending = new Map<string, Promise<Buffer>>();
  let tail = Promise.resolve();
  return (original: Buffer, variant: "thumb" | "display") => {
    const key = `${createHash("sha256").update(original).digest("hex")}-${variant}-v1.webp`;
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
            width: variant === "thumb" ? 400 : 1600,
            height: variant === "thumb" ? 400 : 1600,
            fit: "inside",
            withoutEnlargement: true,
          })
          .keepIccProfile()
          .webp({ lossless: true, effort: 3 })
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
