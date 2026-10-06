import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePdfPages } from "./document-pdf-decoder.ts";

export type PdfPageSize = { width: number; height: number };
const validPages = (pages: unknown): pages is PdfPageSize[] =>
  Array.isArray(pages) &&
  pages.length > 0 &&
  pages.length <= 2000 &&
  pages.every(
    (page) =>
      !!page &&
      typeof page === "object" &&
      Number.isFinite(page.width) &&
      page.width > 0 &&
      Number.isFinite(page.height) &&
      page.height > 0,
  );

/** Immutable originals share a small disk manifest; decoding stays serialized. */
export function pdfDocumentPages(directory: string) {
  const pending = new Map<string, Promise<PdfPageSize[]>>();
  let tail = Promise.resolve();
  const controller = new AbortController();
  const pages = async (path: string) => {
    if (controller.signal.aborted) throw new Error("Подготовка PDF отменена");
    const info = await stat(path);
    const key = createHash("sha256")
      .update(`${path}:${info.size}:${info.mtimeMs}`)
      .digest("hex");
    const cachedPath = join(directory, `${key}-v1.json`);
    try {
      const cached: unknown = JSON.parse(await readFile(cachedPath, "utf8"));
      if (validPages(cached)) return cached;
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw error;
    }
    if (pending.has(key)) return await pending.get(key)!;
    if (pending.size >= 8) throw new Error("Очередь подготовки PDF заполнена");
    const task = tail.then(async () => {
        const result = await decodePdfPages(path, controller.signal);
        if (!validPages(result))
          throw new Error("Некорректные размеры страниц PDF");
        await mkdir(directory, { recursive: true });
        const temporary = join(directory, `.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(result));
          await rename(temporary, cachedPath);
        } finally {
          await rm(temporary, { force: true });
        }
        return result;
    });
    pending.set(key, task);
    tail = task.then(
      () => {},
      () => {},
    );
    try {
      return await task;
    } finally {
      pending.delete(key);
    }
  };
  return Object.assign(pages, {
    async close() {
      controller.abort();
      await tail;
    },
  });
}
