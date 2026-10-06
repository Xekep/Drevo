import { readFile, stat } from "node:fs/promises";
import { MAX_PDF_BYTES } from "../shared/upload-limits.ts";

// An isolated process: no archive credentials, bounded V8 heap, parent deadline.
async function decode(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_PDF_BYTES)
    throw new Error("PDF превышает лимит размера");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(await readFile(path)),
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages < 1 || pdf.numPages > 2000)
      throw new Error("PDF должен содержать от 1 до 2000 страниц");
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      pages.push({ width: viewport.width, height: viewport.height });
      page.cleanup();
    }
    return pages;
  } finally {
    await loading.destroy();
  }
}

try {
  const pages = await decode(process.argv[2]);
  process.send?.({ pages });
} catch {
  process.send?.({ error: "Не удалось прочитать PDF" });
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}
