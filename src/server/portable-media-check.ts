import { open } from "node:fs/promises";
import sharp from "sharp";
import { documentFileTypeFromName } from "../shared/document-file.ts";
import {
  documentImageExtension,
  tiffDocumentPages,
} from "./document-images.ts";
import { PortablePackageError } from "./portable-package.ts";

export async function verifyPortableMediaFile(path: string, name: string) {
  const handle = await open(path, "r");
  const header = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const expectedExtension = documentFileTypeFromName(name)?.extension;
  if (expectedExtension === "pdf") {
    if (header.toString("ascii", 0, 5) !== "%PDF-")
      throw new PortablePackageError("Документ в пакете не является PDF");
    return;
  }
  try {
    if (documentImageExtension(header) !== expectedExtension)
      throw new PortablePackageError(
        "Тип изображения не соответствует расширению",
      );
    await sharp(path, { limitInputPixels: 50_000_000 }).metadata();
    if (expectedExtension === "tif") await tiffDocumentPages(path);
  } catch (error) {
    if (error instanceof PortablePackageError) throw error;
    throw new PortablePackageError("Повреждённое изображение в пакете Drevo");
  }
}
