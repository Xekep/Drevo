import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { openPromise } from "yauzl";
import type { Family, Person } from "../src/domain/types.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import {
  offlineDocuments,
  offlineFamily,
  writeOfflinePackage,
} from "../src/server/offline-package.ts";

const photoName = "11111111-1111-1111-1111-111111111111.png";
const documentName = "22222222-2222-2222-2222-222222222222.pdf";
const scannedDocumentName = "33333333-3333-3333-3333-333333333333.png";
const person = (id: string, patch: Partial<Person> = {}): Person => ({
  id,
  name: id,
  surname: "Тестов",
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
  ...patch,
});
const family: Family = {
  title: "Семья </script><script>window.injected=true</script>",
  description: "",
  demo: false,
  people: [
    person("root", { name: "Анна", photo: `/media/${photoName}` }),
    person("child", { name: "Борис", parents: ["root"] }),
    person("hidden", { name: "Секрет", createdBy: "other" }),
  ],
  links: [],
  photos: [
    {
      id: "photo",
      url: `/media/${photoName}`,
      title: "Снимок",
      tags: [
        {
          id: "visible-tag",
          personId: "root",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        {
          id: "hidden-tag",
          personId: "hidden",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ],
    },
  ],
};

test("offline branch removes hidden people, tags, creator IDs, and unrelated documents", () => {
  const user = {
    id: "reader",
    role: "reader",
    treeAccess: "common_ancestors",
    personId: "root",
    name: "Читатель",
    createdAt: "2026-01-01T00:00:00.000Z",
  } satisfies ArchiveUser;
  const scoped = offlineFamily(projectFamilyForUser(family, user), "all");
  assert.deepEqual(
    scoped.people.map((p) => p.id),
    ["root", "child"],
  );
  assert.deepEqual(
    scoped.photos?.[0].tags.map((t) => t.personId),
    ["root"],
  );
  assert.equal(scoped.people[0].photo, `media/${photoName}`);
  assert.ok(!JSON.stringify(scoped).includes("createdBy"));
  assert.throws(() => offlineFamily(scoped, "family", "hidden"));
  const documents = offlineDocuments(
    [
      {
        id: "visible",
        title: "Запись",
        file_name: documentName,
        created_at: "2026-01-01",
        document_type: "metrical record",
        document_date: "1887",
        place: "Rezh",
        description: "Register page 12",
        provenance: "GASO F6 Op13 D104",
      },
      {
        id: "hidden",
        title: "Скрыто",
        file_name: documentName,
        created_at: "2026-01-01",
      },
      {
        id: "unlinked",
        title: "Без связи",
        file_name: documentName,
        created_at: "2026-01-01",
      },
    ],
    [
      { document_id: "visible", person_id: "root" },
      { document_id: "hidden", person_id: "hidden" },
    ],
    scoped,
    false,
  );
  assert.deepEqual(
    documents.map((d) => d.id),
    ["visible"],
  );
  assert.equal(documents[0].provenance, "GASO F6 Op13 D104");
});

test("offline ZIP contains verified original media and a syntactically valid standalone reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-offline-test-"));
  const uploads = join(directory, "uploads");
  try {
    await mkdir(uploads);
    const image = Buffer.from("original-image");
    const pdf = Buffer.from("%PDF-1.4\noriginal-document");
    const scan = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6+fIAAAAASUVORK5CYII=", "base64");
    await writeFile(join(uploads, photoName), image);
    await writeFile(join(uploads, documentName), pdf);
    await writeFile(join(uploads, scannedDocumentName), scan);
    const scoped = offlineFamily(family, "family", "root");
    const documents = offlineDocuments(
      [
        {
          id: "doc",
          title: "Метрическая запись",
          file_name: documentName,
          created_at: "2026-01-01",
        },
        {
          id: "scan",
          title: "Скан метрической записи",
          file_name: scannedDocumentName,
          created_at: "2026-01-01",
        },
      ],
      [
        { document_id: "doc", person_id: "root" },
        { document_id: "scan", person_id: "root" },
      ],
      scoped,
      false,
    );
    const destination = join(directory, "archive.zip");
    await writeOfflinePackage(
      destination,
      uploads,
      scoped,
      documents,
      7,
      "family",
    );
    const zip = await openPromise(destination);
    const contents = new Map<string, Buffer>();
    for await (const entry of zip.eachEntry()) {
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry))
        chunks.push(Buffer.from(chunk));
      contents.set(entry.fileName, Buffer.concat(chunks));
    }
    assert.deepEqual(
      [...contents.keys()].sort(),
      [
        "documents.json",
        "family.json",
        "gedcom.ged",
        "index.html",
        "manifest.json",
        `media/${documentName}`,
        `media/${scannedDocumentName}`,
        `media/${photoName}`,
      ].sort(),
    );
    assert.deepEqual(contents.get(`media/${photoName}`), image);
    assert.deepEqual(contents.get(`media/${documentName}`), pdf);
    assert.deepEqual(contents.get(`media/${scannedDocumentName}`), scan);
    const manifest = JSON.parse(
      contents.get("manifest.json")!.toString("utf8"),
    );
    for (const file of manifest.files)
      assert.equal(
        createHash("sha256").update(contents.get(file.name)!).digest("hex"),
        file.sha256,
      );
    const html = contents.get("index.html")!.toString("utf8");
    assert.ok(!html.includes("</script><script>window.injected"));
    assert.match(html, /\\u003c\/script>/);
    const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    new Script(script);
    assert.match(contents.get("gedcom.ged")!.toString("utf8"), /2 VERS 7\.0/);
    assert.ok((await readFile(destination)).length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline ZIP refuses missing originals before creating a download", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-offline-missing-"));
  try {
    await assert.rejects(() =>
      writeOfflinePackage(
        join(directory, "archive.zip"),
        directory,
        offlineFamily(family, "family", "root"),
        [],
        1,
        "family",
      ),
    );
    await assert.rejects(() => readFile(join(directory, "archive.zip")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline ZIP keeps a citation-only local original usable from family.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-offline-citation-"));
  const localName = "44444444-4444-4444-4444-444444444444.pdf";
  const originalUrl = `/media/${localName}#page=7`;
  const bytes = Buffer.from("%PDF-1.4\ncitation-only-original");
  try {
    await writeFile(join(directory, localName), bytes);
    const sourceFamily: Family = {
      ...family,
      people: [person("root", {
        sources: [
          { title: "Register", type: "archive", reference: "p. 7", url: originalUrl },
          { title: "External", type: "web", reference: "", url: "https://archive.example/7" },
        ],
        events: [{ id: "event", type: "residence", sources: [
          { title: "Same register", type: "archive", reference: "", url: originalUrl },
        ] }],
      })],
      photos: [],
    };
    const scoped = offlineFamily(sourceFamily, "all");
    assert.equal(sourceFamily.people[0].sources[0].url, originalUrl);
    assert.equal(scoped.people[0].sources[0].url, `media/${localName}#page=7`);
    assert.equal(scoped.people[0].sources[1].url, "https://archive.example/7");
    const destination = join(directory, "archive.zip");
    await writeOfflinePackage(destination, directory, scoped, [], 1, "all");
    const zip = await openPromise(destination);
    const contents = new Map<string, Buffer>();
    for await (const entry of zip.eachEntry()) {
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry))
        chunks.push(Buffer.from(chunk));
      contents.set(entry.fileName, Buffer.concat(chunks));
    }
    assert.deepEqual(contents.get(`media/${localName}`), bytes);
    assert.equal([...contents.keys()].filter((name) => name === `media/${localName}`).length, 1);
    const restored = JSON.parse(contents.get("family.json")!.toString("utf8")) as Family;
    assert.equal(restored.people[0].sources[0].url, `media/${localName}#page=7`);
    assert.equal(restored.people[0].events?.[0].sources?.[0].url, `media/${localName}#page=7`);
    const manifest = JSON.parse(contents.get("manifest.json")!.toString("utf8"));
    assert.equal(manifest.files.find((entry: { name: string }) => entry.name === `media/${localName}`).sha256,
      createHash("sha256").update(bytes).digest("hex"));
    await rm(join(directory, localName));
    const missing = join(directory, "missing.zip");
    await assert.rejects(() => writeOfflinePackage(missing, directory, scoped, [], 1, "all"));
    await assert.rejects(() => readFile(missing));
    for (const url of ["/media/../outside.pdf", `/media/${localName}/../outside.pdf`])
      assert.throws(() => offlineFamily({ ...sourceFamily, people: [person("root", {
        sources: [{ title: "Invalid", type: "archive", reference: "", url }],
      })] }, "all"), /Некорректный путь оригинала источника/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
