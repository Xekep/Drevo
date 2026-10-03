import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import PDFDocument from "pdfkit";
import { pdfDocumentPages } from "../src/server/document-pdf.ts";

test("PDF manifest preserves mixed page sizes, crop, rotation and reuses the disk cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-pdf-manifest-"));
  const cache = join(directory, "cache"),
    path = join(directory, "original.pdf");
  const pdf = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) =>
    pdf.on("end", () => resolve(Buffer.concat(chunks))),
  );
  pdf.addPage({ size: [100, 200] });
  pdf.addPage({ size: [400, 600] });
  Object.assign(pdf.page.dictionary.data, {
    CropBox: [10, 20, 300, 420],
    Rotate: 90,
    UserUnit: 2,
  });
  pdf.end();
  const reader = pdfDocumentPages(cache);
  try {
    await writeFile(path, await done);
    const [first, simultaneous] = await Promise.all([
      reader(path),
      reader(path),
    ]);
    assert.deepEqual(first, [
      { width: 100, height: 200 },
      { width: 800, height: 580 },
    ]);
    assert.deepEqual(simultaneous, first);
    assert.equal((await readdir(cache)).length, 1);
    const cached = join(cache, (await readdir(cache))[0]);
    assert.deepEqual(JSON.parse(await readFile(cached, "utf8")), first);
    const reopened = pdfDocumentPages(cache);
    assert.deepEqual(await reopened(path), first);
    await reopened.close();
    await writeFile(cached, "[null]");
    assert.deepEqual(
      await reader(path),
      first,
      "a corrupt manifest is rebuilt",
    );
  } finally {
    await reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});
