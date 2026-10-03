import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import sharp from "sharp";
import type { Family } from "../src/domain/types.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { familyMedia } from "../src/domain/genealogy-transfer.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { openArchive } from "../src/server/database.ts";
import { gedcomHttp } from "../src/server/gedcom-http.ts";
import type { createAuth } from "../src/server/auth.ts";

const photoName = "b17b339b-3051-4859-872f-f29174494f43.png";
const createdAt = "2020-01-02T03:04:05.000Z";
const family: Family = {
  title: "Album", description: "", demo: false,
  people: [{
    id: "person", name: "Anna", surname: "Ivanova", patronymic: "", sex: "f",
    birth: "1900", birthPlace: "", parents: [], spouses: [], sources: [],
    generation: 1, column: 0,
  }],
  photos: [{
    id: "photo", url: `/media/${photoName}`, title: "Family portrait",
    createdAt, takenAt: "1918-06-01", tags: [{
      id: "tag", personId: "person", x: 0.1, y: 0.2, width: 0.3, height: 0.4,
    }],
  }],
};

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} retains gallery upload and capture dates separately`, () => {
    const restored = importGedcom(exportGedcom(family, {
      version, media: familyMedia(family),
    }), `photo-${version}`);
    assert.equal(restored.media[0].photo?.createdAt, createdAt);
    assert.equal(restored.media[0].photo?.takenAt, "1918-06-01");
  });

test("GEDZIP restores gallery upload date, capture date and original image", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-gedzip-photo-created-"));
  try {
    const uploads = join(root, "uploads"), stage = join(root, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const original = await sharp({ create: { width: 2, height: 2, channels: 4,
      background: "#5a79ad" } }).png().toBuffer();
    await writeFile(join(uploads, photoName), original);
    const zip = join(root, "archive.gdz");
    await writeGenealogyPackage(zip, uploads, family, familyMedia(family));
    const restored = await prepareGenealogyImport(zip, stage, "photo-zip");
    assert.equal(restored.family.photos?.[0].createdAt, createdAt);
    assert.equal(restored.family.photos?.[0].takenAt, "1918-06-01");
    assert.deepEqual(await readFile(join(stage, restored.files[0].name)), original);

    const dbPath = join(root, "target.sqlite");
    const target = await openArchive(dbPath, {
      title: "Target", description: "", demo: false, people: [], photos: [],
    });
    const auth = { currentUser: () => ({
      id: "admin", name: "Admin", role: "admin", approved: true, createdAt: "",
    }) } as unknown as Awaited<ReturnType<typeof createAuth>>;
    const route = gedcomHttp(target, auth, dbPath, "https://test.invalid");
    const server = createServer(async (req, res) => {
      await route.handle(req, res, new URL(req.url!, "https://test.invalid"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const headers = { Origin: "https://test.invalid", "X-Drevo-Import": "1" };
      const preview = await fetch(`${base}/api/gedcom/preview`, {
        method: "POST", headers, body: new Uint8Array(await readFile(zip)),
      });
      assert.equal(preview.status, 200,
        preview.status === 200 ? "" : await preview.text());
      const { token } = await preview.json() as { token: string };
      const applied = await fetch(`${base}/api/gedcom/import`, {
        method: "POST", headers, body: JSON.stringify({ token, confirm: true }),
      });
      assert.equal(applied.status, 200, await applied.text());
      const stored = (await target.read()).family.photos?.[0];
      assert.equal(stored?.createdAt, createdAt);
      assert.equal(stored?.takenAt, "1918-06-01");
    } finally {
      await route.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await target.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
