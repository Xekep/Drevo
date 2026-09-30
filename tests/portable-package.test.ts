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
import { ZipFile } from "yazl";
import type { Family } from "../src/domain/types.ts";
import {
  writePortablePackage,
  type PortableSnapshot,
  type PortableManifest,
} from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";

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
    const image = Buffer.from("original photo bytes");
    const pdf = Buffer.from("%PDF-1.4\nportable document");
    await writeFile(join(uploads, "portrait.png"), image);
    await writeFile(join(uploads, "record.pdf"), pdf);
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
          sources: [],
          photo: "/media/portrait.png",
        },
      ],
      photos: [],
    };
    const snapshot: PortableSnapshot = {
      family,
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
      ],
      comments: [
        {
          id: 1,
          personId: "p1",
          authorId: "owner",
          authorName: "Владелец",
          createdMs: 1,
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
    ]);
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
    assert.equal(imported.files.get("media/record.pdf")?.sha256, hash(pdf));
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
