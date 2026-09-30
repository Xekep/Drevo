import { open } from "node:fs/promises";
import { extname } from "node:path";
import sharp from "sharp";
import { imageExtension } from "./media.ts";
import { PortablePackageError } from "./portable-package.ts";

export async function verifyPortableMediaFile(path: string, name: string) {
  const handle = await open(path, "r");
  const header = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const extension = extname(name).slice(1).toLowerCase();
  if (extension === "pdf") {
    if (header.toString("ascii", 0, 5) !== "%PDF-")
      throw new PortablePackageError("Документ в пакете не является PDF");
    return;
  }
  try {
    if (imageExtension(header) !== extension)
      throw new PortablePackageError(
        "Тип изображения не соответствует расширению",
      );
    await sharp(path, { limitInputPixels: 50_000_000 }).metadata();
  } catch (error) {
    if (error instanceof PortablePackageError) throw error;
    throw new PortablePackageError("Повреждённое изображение в пакете Drevo");
  }
}
