import test from "node:test";
import assert from "node:assert/strict";
import { ZipFile } from "yazl";
import { detectImportFileFormat } from "../src/components/import-file-format.ts";

async function zip(names: string[], zip64 = false) {
  const archive = new ZipFile();
  for (const name of names)
    archive.addBuffer(Buffer.from("synthetic content"), name);
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.on("error", reject);
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  archive.end({ forceZip64Format: zip64, comment: "" });
  return new File([new Uint8Array(await result)], "renamed.json");
}

test("content selects GEDCOM/XML/JSON independently of misleading extensions", async () => {
  assert.equal(
    await detectImportFileFormat(
      new File(["\uFEFF0 HEAD\n1 GEDC\n2 VERS 7.0\n0 TRLR"], "archive.json"),
    ),
    "gedcom",
  );
  assert.equal(
    await detectImportFileFormat(
      new File(
        [Buffer.from("\uFEFF0 HEAD\r\n0 TRLR", "utf16le")],
        "archive.xml",
      ),
    ),
    "gedcom",
  );
  assert.equal(
    await detectImportFileFormat(
      new File(["<?xml version='1.0'?><agelongtree/>"], "archive.ged"),
    ),
    "xml",
  );
  assert.equal(
    await detectImportFileFormat(
      new File(['{"title":"Пример","people":[]}'], "archive.gdz"),
    ),
    "json",
  );
  assert.equal(
    await detectImportFileFormat(
      new File(
        [
          '{"note":"' +
            "a".repeat(17_000) +
            '","format":"drevo.reviewed-add-only","version":1}',
        ],
        "archive.xml",
      ),
    ),
    "additions",
  );
});

test("ZIP metadata distinguishes genealogical, XML and portable archives without decompressing files", async () => {
  assert.equal(
    await detectImportFileFormat(await zip(["gedcom.ged", "media/photo.png"])),
    "gedzip",
  );
  assert.equal(
    await detectImportFileFormat(
      await zip(["export/tree.xml", "export/tree.files/photo.png"]),
    ),
    "xml",
  );
  assert.equal(
    await detectImportFileFormat(
      await zip(["manifest.json", "archive.json", "media/photo.png"]),
    ),
    "drevo",
  );
  assert.equal(
    await detectImportFileFormat(
      await zip(["manifest.json", "archive.json"], true),
    ),
    "drevo",
  );
  const extended = new Uint8Array(await (await zip(["manifest.json", "archive.json"], true)).arrayBuffer());
  const footer = new DataView(extended.buffer);
  footer.setUint32(extended.length - 22 + 12, 0xffffffff, true);
  footer.setUint32(extended.length - 22 + 16, 0xffffffff, true);
  assert.equal(await detectImportFileFormat(new Blob([extended])), "drevo");
  await assert.rejects(
    detectImportFileFormat(await zip(["first.xml", "second.xml"])),
    /не найден/,
  );
});

test("invalid, truncated and oversized inputs fail before reaching any import endpoint", async () => {
  await assert.rejects(
    detectImportFileFormat(new File(["not a family archive"], "archive.ged")),
    /не распознан/,
  );
  await assert.rejects(
    detectImportFileFormat(new File(['{"broken":'], "archive.json")),
    /прочитать JSON/,
  );
  await assert.rejects(
    detectImportFileFormat(
      new File([new Uint8Array([80, 75, 3, 4])], "archive.gdz"),
    ),
    /Повреждён ZIP/,
  );
  await assert.rejects(
    detectImportFileFormat(
      new File(["{", new Uint8Array(8 * 1024 * 1024)], "archive.json"),
    ),
    /8 МБ/,
  );
  const valid = await zip(["gedcom.ged"]);
  await assert.rejects(
    detectImportFileFormat(valid.slice(0, valid.size - 12)),
    /Повреждён ZIP/,
  );
});
