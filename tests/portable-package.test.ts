import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openPromise } from "yauzl";
import sharp from "sharp";
import { ZipFile } from "yazl";
import type { Family } from "../src/domain/types.ts";
import {
  MAX_PORTABLE_ENTRIES,
  MAX_PORTABLE_MANIFEST_BYTES,
  writePortablePackage,
  type PortableSnapshot,
  type PortableManifest,
} from "../src/server/portable-package.ts";
import { portableUncompressedBytes, readPortablePackage } from "../src/server/portable-import.ts";
import { installPortableOriginals } from "../src/server/portable-install.ts";
import { applyPortablePackage } from "../src/server/portable-apply.ts";
import { openArchive } from "../src/server/database.ts";
import { userStore } from "../src/server/users.ts";

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function zipEntries(path: string, files: Map<string, Buffer>) {
  const zip = new ZipFile();
  const output = pipeline(zip.outputStream, createWriteStream(path));
  for (const [name, data] of files) zip.addBuffer(data, name);
  zip.end();
  await output;
}

test("Drevo package exports originals and verifies every entry with SHA-256", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-portable-"));
  try {
    const uploads = join(dir, "uploads");
    await mkdir(uploads);
    const image = await sharp({
      create: { width: 1, height: 1, channels: 4, background: "white" },
    })
      .png()
      .toBuffer();
    const pdf = Buffer.from("%PDF-1.4\nportable document");
    const scan = await sharp({
      create: { width: 12, height: 16, channels: 3, background: "#e2decf" },
    }).png().toBuffer();
    const tiff = await sharp({ create: { width: 12, height: 48, pageHeight: 16, channels: 3, background: "red" } }).tiff().toBuffer();
    await writeFile(join(uploads, "portrait.png"), image);
    await writeFile(join(uploads, "record.pdf"), pdf);
    await writeFile(join(uploads, "scan.png"), scan);
    await writeFile(join(uploads, "scan.tif"), tiff);
    const family: Family = {
      title: "Family",
      description: "Evidence",
      demo: false,
      people: [
        {
          id: "p1",
          surname: "Иванова",
          name: "Мария",
          patronymic: "",
          sex: "f",
          birth: "1880",
          birthPlace: "Томск",
          parents: [],
          spouses: [],
          generation: 1,
          column: 0,
          sources: [{ catalogId: "source-1", title: "Метрическая книга", type: "архив", reference: "ф. 6" }],
          photo: "/media/portrait.png",
        },
      ],
      photos: [],
    };
    const snapshot: PortableSnapshot = {
      family,
      sources: [{
        id: "source-1", title: "Метрическая книга", type: "архив", author: "",
        institution: "", archive: "ГАСО", fond: "6", opis: "13", delo: "104",
        sheet: "12", reference: "ф. 6", url: "", accessedAt: "2026-10-01",
        description: "Запись о рождении", documentIds: ["a38e540d-841d-4205-9548-847939860299"],
      }],
      documents: [
        {
          id: "a38e540d-841d-4205-9548-847939860299",
          title: "Метрическая запись",
          fileName: "record.pdf",
          createdAt: "2026-09-30T00:00:00Z",
          uploadedBy: "owner",
          documentType: "Метрическая книга",
          documentDate: "1880",
          place: "Томск",
          description: "Лист 2",
          provenance: "Архив",
          annotations: [],
          personIds: ["p1"],
        },
        {
          id: "c26d78da-c392-4591-a013-e2d4acdb9230",
          title: "Скан письма",
          fileName: "scan.png",
          createdAt: "2026-09-30T00:00:00Z",
          uploadedBy: "owner",
          documentType: "Письмо",
          documentDate: "1881",
          place: "Томск",
          description: "Оригинал письма",
          provenance: "Семейный архив",
          annotations: [],
          personIds: ["p1"],
        },
        {
          id: "db91a3f8-5a1d-4794-9b7a-ff7e070d5927", title: "Три страницы TIFF",
          fileName: "scan.tif", createdAt: "2026-10-01T00:00:00Z", uploadedBy: "owner",
          documentType: "Письмо", documentDate: "1881", place: "Томск", description: "", provenance: "",
          annotations: [{ id: "4a71a3f8-5a1d-4794-9b7a-ff7e070d5927", authorId: "owner", authorName: "Владелец", createdAt: "2026-10-01T00:00:00Z",
            page: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.1, text: "Вторая страница" }],
          personIds: ["p1"],
        },
      ],
      comments: [
        {
          id: 1,
          personId: "p1",
          authorId: "owner",
          authorName: "Владелец",
          createdMs: 1,
          editedMs: 5,
          text: "Проверено по книге",
        },
      ],
    };
    let ready = false;
    const path = join(dir, "tree.drevo");
    await writePortablePackage(
      createWriteStream(path),
      uploads,
      snapshot,
      async () => {
        ready = true;
      },
    );
    assert.equal(ready, true);
    const zip = await openPromise(path);
    const files = new Map<string, Buffer>();
    for await (const entry of zip.eachEntry()) {
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry))
        chunks.push(Buffer.from(chunk));
      files.set(entry.fileName, Buffer.concat(chunks));
    }
    assert.deepEqual([...files.keys()].sort(), [
      "archive.json",
      "manifest.json",
      "media/portrait.png",
      "media/record.pdf",
      "media/scan.png",
      "media/scan.tif",
    ]);
    assert.equal(
      await portableUncompressedBytes(path),
      [...files.values()].reduce((sum, file) => sum + file.length, 0),
      "the preflight reserves the complete uncompressed ZIP size",
    );
    const manifest = JSON.parse(
      files.get("manifest.json")!.toString(),
    ) as PortableManifest;
    assert.equal(manifest.format, "drevo");
    assert.equal(manifest.version, 1);
    for (const entry of manifest.entries) {
      const data = files.get(entry.path);
      assert.ok(data);
      assert.equal(data.length, entry.size);
      assert.equal(hash(data), entry.sha256);
    }
    assert.deepEqual(
      JSON.parse(files.get("archive.json")!.toString()),
      snapshot,
    );
    const stage = join(dir, "stage");
    await mkdir(stage);
    const imported = await readPortablePackage(path, stage);
    assert.deepEqual(imported.snapshot, snapshot);
    const wrongCitation = structuredClone(snapshot);
    wrongCitation.family.people[0].sources[0].documentId = "c26d78da-c392-4591-a013-e2d4acdb9230";
    const wrongArchive = Buffer.from(JSON.stringify(wrongCitation));
    const wrongManifest = structuredClone(manifest);
    const archiveEntry = wrongManifest.entries.find((entry) => entry.path === "archive.json")!;
    archiveEntry.size = wrongArchive.length;
    archiveEntry.sha256 = hash(wrongArchive);
    const wrongPackage = join(dir, "wrong-source-document.drevo");
    await zipEntries(wrongPackage, new Map(files).set("archive.json", wrongArchive)
      .set("manifest.json", Buffer.from(JSON.stringify(wrongManifest))));
    const wrongStage = join(dir, "wrong-source-stage");
    await mkdir(wrongStage);
    await assert.rejects(readPortablePackage(wrongPackage, wrongStage),
      /источник или документ/);
    assert.equal(imported.files.get("media/record.pdf")?.sha256, hash(pdf));
    assert.equal(imported.files.get("media/scan.png")?.sha256, hash(scan));
    assert.equal(imported.files.get("media/scan.tif")?.sha256, hash(tiff));
    const destination = join(dir, "destination");
    await mkdir(destination);
    const installed = await installPortableOriginals(imported, destination);
    assert.notEqual(
      installed.snapshot.family.people[0].photo,
      "/media/portrait.png",
    );
    assert.notEqual(installed.snapshot.documents[0].fileName, "record.pdf");
    assert.equal(installed.snapshot.comments[0].authorId, "");
    assert.deepEqual(
      await readFile(
        join(destination, installed.snapshot.documents[0].fileName),
      ),
      pdf,
    );
    assert.deepEqual(
      await readFile(join(destination, installed.snapshot.documents[1].fileName)),
      scan,
    );
    assert.deepEqual(await readFile(join(destination, installed.snapshot.documents[2].fileName)), tiff);
    assert.equal(installed.snapshot.documents[2].annotations[0].page, 2);
    const archive = await openArchive(":memory:", {
      title: "Empty",
      description: "",
      demo: false,
      people: [],
      photos: [],
    });
    try {
      const owner = await (
        await userStore(archive.db, { requireInitialAdmin: false })
      ).register("owner", "Owner");
      const revision = (await archive.read()).revision;
      const token = "37add622-72b9-4d29-bc04-f9751e6f9a4a";
      await archive.db
        .prepare(
          "INSERT INTO workflow_stages(token,kind,actor_id,revision,expires_at,data) VALUES(?,'drevo',?,?,?,?)",
        )
        .run(token, owner.id, revision, Date.now() + 60_000, "{}");
      await applyPortablePackage(archive, owner, token, revision, installed);
      const result = await archive.read();
      assert.equal(
        result.family.people[0].photo,
        installed.snapshot.family.people[0].photo,
      );
      assert.equal(
        (await archive.db.prepare("SELECT count(*) AS n FROM documents").get())
          ?.n,
        3,
      );
      assert.equal((await archive.db.prepare("SELECT count(*) AS n FROM source_catalog").get())?.n, 1);
      assert.equal(result.family.people[0].sources[0].catalogId, "source-1");
      assert.equal((await archive.db.prepare("SELECT updated_ms FROM person_comments").get())?.updated_ms, 5);
      assert.equal(
        (
          await archive.db
            .prepare("SELECT author_name FROM person_comments")
            .get()
        )?.author_name,
        "Владелец",
      );
      await assert.rejects(
        applyPortablePackage(archive, owner, token, revision, installed),
      );
    } finally {
      await archive.close();
    }
    await installed.undo();
    await assert.rejects(
      readFile(join(destination, installed.snapshot.documents[0].fileName)),
      { code: "ENOENT" },
    );
    const tampered = new Map(files);
    const alteredManifest: PortableManifest = structuredClone(manifest);
    alteredManifest.entries[0].sha256 = "0".repeat(64);
    tampered.set("manifest.json", Buffer.from(JSON.stringify(alteredManifest)));
    const tamperedPath = join(dir, "tampered.drevo");
    await zipEntries(tamperedPath, tampered);
    const tamperedStage = join(dir, "tampered-stage");
    await mkdir(tamperedStage);
    await assert.rejects(
      readPortablePackage(tamperedPath, tamperedStage),
      /SHA-256/,
    );
    const unsafe = new Map(files);
    unsafe.set("media/executable.sh", Buffer.from("bad"));
    const unsafePath = join(dir, "unsafe.drevo");
    await zipEntries(unsafePath, unsafe);
    const unsafeStage = join(dir, "unsafe-stage");
    await mkdir(unsafeStage);
    await assert.rejects(
      readPortablePackage(unsafePath, unsafeStage),
      /Недопустимое вложение/,
    );
    assert.deepEqual(await readFile(join(uploads, "record.pdf")), pdf);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Drevo exports and imports a media manifest larger than the former 8 KiB cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-portable-manifest-"));
  try {
    const uploads = join(dir, "uploads");
    const stage = join(dir, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const image = await sharp({
      create: { width: 1, height: 1, channels: 4, background: "white" },
    }).png().toBuffer();
    const photos = Array.from({ length: 100 }, (_, index) => ({
      id: `photo-${index}`,
      url: `/media/photo-${index}.png`,
      title: `Photo ${index}`,
      tags: [],
    }));
    await Promise.all(photos.map((_, index) =>
      writeFile(join(uploads, `photo-${index}.png`), image)));
    const snapshot: PortableSnapshot = {
      family: { title: "Tree", description: "", demo: false, people: [], photos },
      documents: [],
      comments: [],
    };
    const path = join(dir, "tree.drevo");
    await writePortablePackage(createWriteStream(path), uploads, snapshot, async () => {});
    const zip = await openPromise(path);
    let manifestBytes = 0;
    try {
      for await (const entry of zip.eachEntry())
        if (entry.fileName === "manifest.json") manifestBytes = entry.uncompressedSize;
    } finally {
      zip.close();
    }
    assert.ok(manifestBytes > 8 * 1024);
    assert.ok(manifestBytes <= MAX_PORTABLE_MANIFEST_BYTES);
    const imported = await readPortablePackage(path, stage);
    assert.deepEqual(imported.snapshot.family.photos, photos);
    assert.equal(imported.files.size, photos.length + 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Drevo export rejects an original changed after manifest hashing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-portable-changing-original-"));
  const output = new PassThrough();
  output.resume();
  try {
    const original = Buffer.from("%PDF-1.4\nversion1\n%%EOF");
    const changed = Buffer.from("%PDF-1.4\nversion2\n%%EOF");
    assert.equal(original.length, changed.length);
    await writeFile(join(dir, "record.pdf"), original);
    const snapshot: PortableSnapshot = {
      family: { title: "Tree", description: "", demo: false, people: [] },
      documents: [{ id: "11111111-1111-4111-8111-111111111111", title: "Record",
        fileName: "record.pdf", createdAt: "2026-10-01T00:00:00Z", uploadedBy: "owner",
        documentType: "", documentDate: "", place: "", description: "",
        provenance: "", annotations: [], personIds: [] }],
      comments: [],
    };
    let checked = false;
    await assert.rejects(writePortablePackage(output, dir, snapshot, async () => {
      checked = true;
      await writeFile(join(dir, "record.pdf"), changed);
    }), /оригинал изменился/i);
    assert.equal(checked, true, "the replacement happens after the manifest hash");
    await writeFile(join(dir, "record.pdf"), original);
    const removedOutput = new PassThrough();
    removedOutput.resume();
    try {
      await assert.rejects(writePortablePackage(removedOutput, dir, snapshot, async () => {
        await rm(join(dir, "record.pdf"));
      }), /ENOENT/);
    } finally {
      removedOutput.destroy();
    }
  } finally {
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Drevo rejects an export exceeding the importer's ZIP entry cap before sending it", async () => {
  const snapshot: PortableSnapshot = {
    family: {
      title: "Tree", description: "", demo: false, people: [],
      photos: Array.from({ length: MAX_PORTABLE_ENTRIES - 1 }, (_, index) => ({
        id: `photo-${index}`, url: `/media/photo-${index}.png`, title: "", tags: [],
      })),
    },
    documents: [], comments: [],
  };
  const output = new PassThrough();
  let started = false;
  let bytes = 0;
  output.on("data", (chunk: Buffer) => { bytes += chunk.length; });
  await assert.rejects(
    writePortablePackage(output, "unused", snapshot, async () => { started = true; }),
    /слишком много файлов/,
  );
  assert.equal(started, false);
  assert.equal(bytes, 0);
  output.destroy();
});

test("Drevo rejects a package that omits an original used only by an inline citation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-citation-media-"));
  try {
    const uploads = join(dir, "uploads");
    const stage = join(dir, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const image = await sharp({ create: {
      width: 1, height: 1, channels: 4, background: "white",
    } }).png().toBuffer();
    await writeFile(join(uploads, "evidence.png"), image);
    const snapshot: PortableSnapshot = {
      family: { title: "Tree", description: "", demo: false, photos: [], people: [{
        id: "p1", surname: "Иванов", name: "Пётр", patronymic: "", sex: "m",
        birth: "", birthPlace: "", parents: [], spouses: [], generation: 1,
        column: 0, sources: [
          { title: "Фото", type: "архив", reference: "", url: "/media/evidence.png" },
          { title: "Оборот фото", type: "архив", reference: "", url: "/media/evidence.png" },
          { title: "Внешний каталог", type: "архив", reference: "",
            url: "https://archives.example.org/record/1" },
        ],
      }] },
      documents: [], comments: [],
    };
    const path = join(dir, "complete.drevo");
    await writePortablePackage(createWriteStream(path), uploads, snapshot, async () => {});
    const zip = await openPromise(path);
    const files = new Map<string, Buffer>();
    let mediaEntryCount = 0;
    try {
      for await (const entry of zip.eachEntry()) {
        if (entry.fileName === "media/evidence.png") mediaEntryCount++;
        const chunks: Buffer[] = [];
        for await (const chunk of await zip.openReadStreamPromise(entry))
          chunks.push(Buffer.from(chunk));
        files.set(entry.fileName, Buffer.concat(chunks));
      }
    } finally {
      zip.close();
    }
    assert.equal(mediaEntryCount, 1,
      "the same original cited twice is stored once");
    const complete = await readPortablePackage(path, stage);
    assert.equal(complete.files.get("media/evidence.png")?.sha256, hash(image));
    assert.equal(complete.snapshot.family.people[0].sources[2].url,
      "https://archives.example.org/record/1");
    const unsafeSnapshot = structuredClone(snapshot);
    unsafeSnapshot.family.people[0].sources[0].url = "/media/../secret.png";
    const unsafeArchive = Buffer.from(JSON.stringify(unsafeSnapshot));
    const unsafeManifest = JSON.parse(files.get("manifest.json")!.toString()) as PortableManifest;
    const archiveEntry = unsafeManifest.entries.find((entry) => entry.path === "archive.json")!;
    archiveEntry.size = unsafeArchive.length;
    archiveEntry.sha256 = hash(unsafeArchive);
    const unsafe = join(dir, "unsafe-citation.drevo");
    await zipEntries(unsafe, new Map(files)
      .set("archive.json", unsafeArchive)
      .set("manifest.json", Buffer.from(JSON.stringify(unsafeManifest))));
    const unsafeStage = join(dir, "unsafe-stage");
    await mkdir(unsafeStage);
    await assert.rejects(readPortablePackage(unsafe, unsafeStage), /Некорректный путь оригинала источника/);
    const output = new PassThrough();
    let started = false;
    let bytes = 0;
    output.on("data", (chunk: Buffer) => { bytes += chunk.length; });
    await assert.rejects(writePortablePackage(output, uploads, unsafeSnapshot,
      async () => { started = true; }), /Некорректный путь оригинала источника/);
    assert.equal(started, false);
    assert.equal(bytes, 0);
    output.destroy();
    const manifest = JSON.parse(files.get("manifest.json")!.toString()) as PortableManifest;
    manifest.entries = manifest.entries.filter((entry) => entry.path !== "media/evidence.png");
    files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    files.delete("media/evidence.png");
    const missing = join(dir, "missing.drevo");
    await zipEntries(missing, files);
    const missingStage = join(dir, "missing-stage");
    await mkdir(missingStage);
    await assert.rejects(readPortablePackage(missing, missingStage), /отсутствует оригинал/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Drevo package rejects missing or unsafe originals before writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-portable-"));
  try {
    const snapshot: PortableSnapshot = {
      family: {
        title: "Tree",
        description: "",
        demo: false,
        people: [],
        photos: [
          { id: "p", url: "/media/missing.png", title: "Missing", tags: [] },
        ],
      },
      documents: [],
      comments: [],
    };
    const output = new PassThrough();
    let bytes = 0;
    let ready = false;
    output.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    await assert.rejects(
      writePortablePackage(output, dir, snapshot, async () => {
        ready = true;
      }),
      /ENOENT/,
    );
    assert.equal(ready, false);
    assert.equal(bytes, 0);
    output.destroy();
    snapshot.family.photos![0].url = "/media/../secret.pdf";
    await assert.rejects(
      writePortablePackage(new PassThrough(), dir, snapshot, async () => {}),
      /Некорректный путь/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
