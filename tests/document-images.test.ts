import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  documentFileTypeFromName,
  documentFileTypeFromMime,
} from "../src/shared/document-file.ts";
import {
  tiffDocumentPages,
  tiffDocumentRenderer,
} from "../src/server/document-images.ts";

test("TIFF aliases use the canonical archival format and 50 MiB limit", () => {
  for (const name of ["record.tif", "record.TIFF"]) {
    assert.deepEqual(documentFileTypeFromName(name), {
      extension: "tif",
      mime: "image/tiff",
      maxBytes: 50 * 1024 * 1024,
    });
  }
  assert.deepEqual(
    documentFileTypeFromMime("image/x-tiff"),
    documentFileTypeFromMime("image/tiff"),
  );
});

test("TIFF orientation is consistent between the page manifest and rendered pixels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-tiff-orientation-"));
  try {
    const path = join(dir, "rotated.tif");
    await writeFile(
      path,
      await sharp({
        create: { width: 40, height: 30, channels: 3, background: "red" },
      })
        .withMetadata({ orientation: 6 })
        .tiff()
        .toBuffer(),
    );
    assert.deepEqual(await tiffDocumentPages(path), [
      { width: 30, height: 40 },
    ]);
    const metadata = await sharp(
      await tiffDocumentRenderer()(path, 0),
    ).metadata();
    assert.equal(metadata.width, 30);
    assert.equal(metadata.height, 40);
    const huge = join(dir, "too-many-pages.tif");
    await writeFile(
      huge,
      await sharp({
        create: {
          width: 1,
          height: 2001,
          pageHeight: 1,
          channels: 3,
          background: "red",
        },
      })
        .tiff()
        .toBuffer(),
    );
    await assert.rejects(tiffDocumentPages(huge), /2000/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
