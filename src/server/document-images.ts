import sharp from "sharp";
import { imageExtension } from "./media.ts";

export function documentImageExtension(bytes: Buffer) {
  const signature = bytes.subarray(0, 4).toString("hex");
  if (["49492a00", "4d4d002a", "49492b00", "4d4d002b"].includes(signature))
    return "tif";
  return imageExtension(bytes);
}

const inputOptions = { limitInputPixels: 50_000_000 };

export async function tiffDocumentPages(path: string) {
  const first = await sharp(path, inputOptions).metadata();
  const count = first.pages ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 2000)
    throw new Error("TIFF должен содержать от 1 до 2000 страниц");
  const pages: { width: number; height: number }[] = [];
  for (let index = 0; index < count; index++) {
    const metadata =
      index === 0
        ? first
        : await sharp(path, { ...inputOptions, page: index }).metadata();
    let { width, height } = metadata;
    if (!width || !height || width * height > inputOptions.limitInputPixels)
      throw new Error("Страница TIFF превышает 50 мегапикселей");
    if ((metadata.orientation ?? 1) >= 5) [width, height] = [height, width];
    pages.push({ width, height });
  }
  return pages;
}

/** Serialize TIFF decoding and share concurrent requests for the same page. */
export function tiffDocumentRenderer() {
  const pending = new Map<string, Promise<Buffer>>();
  let tail = Promise.resolve();
  return (path: string, page: number) => {
    const key = `${path}:${page}`;
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 32)
      throw new Error("Очередь подготовки страниц TIFF заполнена");
    const result = tail.then(() =>
      sharp(path, { ...inputOptions, page })
        .rotate()
        .resize({
          width: 2400,
          height: 2400,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 92 })
        .toBuffer(),
    );
    tail = result.then(
      () => {},
      () => {},
    );
    pending.set(key, result);
    void result.finally(() => pending.delete(key)).catch(() => {});
    return result;
  };
}
