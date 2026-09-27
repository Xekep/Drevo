import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { openPromise } from "yauzl";
import sharp from "sharp";
import { createServer } from "node:http";
import { importGedcom, exportGedcom } from "../src/domain/gedcom.ts";
import {
  importAgelongXml,
  exportAgelongXml,
} from "../src/domain/agelong-xml.ts";
import { familyMedia } from "../src/domain/genealogy-transfer.ts";
import {
  prepareGenealogyImport,
  writeGenealogyPackage,
  decodeGedcom,
  packagePath,
} from "../src/server/genealogy-package.ts";
import { openArchive } from "../src/server/database.ts";
import { gedcomHttp } from "../src/server/gedcom-http.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { Family, Person } from "../src/domain/types.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

const person = (id: string, patch: Partial<Person> = {}): Person => ({
  id,
  name: id,
  surname: "Тестов",
  patronymic: "",
  birth: "",
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  sex: "u",
  generation: 1,
  column: 0,
  ...patch,
});
const seed = (): Family => ({
  title: "Архив",
  description: "",
  demo: false,
  people: [
    person("parent", { spouses: ["partner"], sex: "m" }),
    person("partner", { spouses: ["parent"], sex: "f" }),
    person("child", { parents: ["parent", "partner"] }),
  ],
  photos: [],
  links: [],
});
const external7 = `0 HEAD
1 GEDC
2 VERS 7.0.18
0 @I1@ INDI
1 NAME Алексей /Тестов/
1 NOTE @@начало @середина @@два
2 CONT @@вторая
1 SNOTE @N@
1 BIRT
2 DATE ABT 1900
1 ASSO @I2@
2 ROLE GODP
1 OBJE @M@
0 @I2@ INDI
1 NAME Мария /Тестова/
0 @N@ SNOTE Общая заметка
1 CONT Вторая строка
0 @M@ OBJE
1 FILE media/photo.png
2 FORM image/png
2 TITL Портрет
0 TRLR
`;

test("GEDCOM 7 external SNOTE, ROLE, escapes, patch versions and media resolve", () => {
  const parsed = importGedcom(external7, "external");
  assert.equal(parsed.version, "7.0.18");
  assert.equal(
    parsed.family.people[0].biography,
    "@начало @середина @@два\n@вторая\n\nОбщая заметка\nВторая строка",
  );
  assert.equal(parsed.family.people[0].events?.[0].dateText, "ABT 1900");
  assert.equal(parsed.family.links?.[0].type, "godparent");
  assert.deepEqual(parsed.media[0].personIds, ["external-p1"]);
  assert.throws(
    () =>
      importGedcom(external7.replace("2 CONT @@вторая", "2 CONC abc"), "bad"),
    /CONC/,
  );
});

test("edited birth fields override imported GEDCOM event; adoption exports as standard PEDI", () => {
  const family = importGedcom(external7, "change").family;
  family.people[0].birth = "1901-02-03";
  family.people[0].birthPlace = "Новое место";
  family.links!.push({
    id: "adopt",
    from: family.people[1].id,
    to: family.people[0].id,
    type: "adoptive_parent",
  });
  const text = exportGedcom(family, { version: "7.0" });
  assert.match(
    text,
    /1 BIRT\r\n2 TYPE Рождение\r\n2 DATE 3 FEB 1901\r\n2 PLAC Новое место/,
  );
  assert.match(text, /2 PEDI ADOPTED/);
  assert.equal(
    importGedcom(text, "again").family.links?.filter(
      (l) => l.type === "adoptive_parent",
    ).length,
    1,
  );
});

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version}: text, sources, notes, xrefs and relationships round trip`, () => {
    const family = seed();
    const p = family.people[0];
    p.name = "@Имя";
    p.maidenName = "Девичья";
    p.surname = "Тест@ов";
    p.biography = "@Первая @@ @I1@\nВторая " + "История 😀 ".repeat(60);
    p.sources = [
      {
        title: "Архив @I1@",
        type: "Книга",
        reference: "@лист 1",
        note: "@цитата",
        url: "https://example.org/record",
      },
    ];
    family.links = [
      { id: "link", type: "godparent", from: "partner", to: "child" },
    ];
    const text = exportGedcom(family, { version });
    if (version === "7.0") {
      assert.doesNotMatch(text, /\d (?:CONC|CHAR|RELA) /);
      assert.match(text, /2 ROLE GODP/);
      assert.match(text, /1 SCHMA/);
    } else {
      assert.match(text, /1 CHAR UTF-8/);
      assert.doesNotMatch(text, /^\d+ CONC {2}/m);
      assert.doesNotMatch(text, / \r\n\d+ CONC /);
      assert.ok(
        text.split("\r\n").every((line) => Buffer.byteLength(line) + 2 <= 255),
      );
    }
    // Check standard fields independently of the Drevo extension.
    const standard = text.replace(
      /^1 _DREVO .*(?:\r?\n2 (?:CONC|CONT).*)*\r?\n/gm,
      "",
    );
    const imported = importGedcom(standard, "back");
    assert.equal(imported.family.people[0].name, p.name);
    assert.equal(imported.family.people[0].maidenName, p.maidenName);
    assert.equal(imported.family.people[0].biography, p.biography);
    assert.equal(
      imported.family.people[0].sources[0].title,
      p.sources[0].title,
    );
    assert.equal(imported.family.people[2].parents.length, 2);
    assert.equal(imported.family.links?.[0].type, "godparent");
  });

const xml = `<?xml version="1.0" encoding="utf-8"?>
<agelongtree lang="ru" dateformat="DD.MM.YYYY"><persons>
<person id="a" sex="М" fn="Алексей" sn="Тестов" mn="Иванович" bdate="Около 1900"><comment>Текст &amp; &lt;заметка&gt;</comment><documents><document id="d" ismain="1" /></documents></person>
<person id="b" sex="Ж" fn="Мария" sn="Тестова" bdate="1902" />
<person id="c" sex="М" fn="Иван" sn="Тестов" bdate="03.02.1930"><nearest><person id="b" relcode="F" /></nearest></person>
</persons><events>
<event id="birth" type="Рождение" date="03.02.1930"><place>Москва</place><persons><person id="c" role="Родился" /><person id="a" role="Отец" /><person id="b" role="Мать" /></persons></event>
<event id="union" type="Свадьба" date="1925"><persons><person id="a" role="Муж" /><person id="b" role="Жена" /></persons></event>
</events><documents><document id="d" path="example.xml.files/photo.png" title="Портрет"><details><detail><person id="a" /></detail></details></document></documents><families><family id="x" /></families></agelongtree>`;

test("Agelong XML uses event roles, preserves uncertainty and escapes; rejects entities and dangling people", () => {
  const result = importAgelongXml(xml, "xml");
  assert.deepEqual(result.family.people[2].parents, ["xml-p1", "xml-p2"]);
  assert.equal(result.family.people[2].birth, "1930-02-03");
  assert.equal(result.family.people[2].birthPlace, "Москва");
  assert.equal(result.family.people[0].birth, "");
  assert.equal(result.family.people[0].events?.[0].dateText, "Около 1900");
  assert.equal(result.family.people[0].biography, "Текст & <заметка>");
  assert.equal(result.family.people[0].spouses[0], "xml-p2");
  assert.deepEqual(result.media[0].portraitIds, ["xml-p1"]);
  assert.throws(
    () =>
      importAgelongXml(
        xml.replace(
          "<agelongtree",
          '<!DOCTYPE agelongtree [<!ENTITY a SYSTEM "file:///etc/passwd">]><agelongtree',
        ),
        "bad",
      ),
    /DTD/,
  );
  assert.throws(
    () =>
      importAgelongXml(
        xml.replace('id="a" role="Отец"', 'id="missing" role="Отец"'),
        "bad",
      ),
    /участник/,
  );
  const copy = importAgelongXml(exportAgelongXml(result.family), "copy");
  assert.equal(copy.family.people.length, 3);
  assert.equal(
    copy.family.people[0].biography,
    result.family.people[0].biography,
  );
  assert.deepEqual(copy.family.people[2].parents, ["copy-p1", "copy-p2"]);
});

async function zipFile(path: string, entries: [string, Buffer][]) {
  const zip = new ZipFile(),
    writing = pipeline(zip.outputStream, createWriteStream(path));
  for (const [name, bytes] of entries) zip.addBuffer(bytes, name);
  zip.end();
  await writing;
}

test("GEDZIP round trip includes exact photo/PDF bytes, portraits, tags, documents and rejects missing media", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-gdz-"));
  try {
    const uploads = join(dir, "uploads");
    await mkdir(uploads);
    const picture = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
    await writeFile(join(uploads, "photo.png"), picture);
    await writeFile(join(uploads, "file.pdf"), pdf);
    const family = seed();
    family.people[0].photo = "/media/photo.png";
    family.photos = [
      {
        id: "photo",
        url: "/media/photo.png",
        title: "Фото",
        year: "1900",
        tags: [
          {
            id: "tag",
            personId: "parent",
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.4,
          },
        ],
      },
    ];
    const media = [
      ...familyMedia(family),
      {
        id: "doc",
        file: "documents/file.pdf",
        title: "Запись",
        mime: "application/pdf",
        personIds: ["child"],
        portraitIds: [],
      },
    ];
    const path = join(dir, "test.gdz");
    await writeGenealogyPackage(path, uploads, family, media);
    const zip = await openPromise(path);
    const names: string[] = [];
    for await (const entry of zip.eachEntry()) names.push(entry.fileName);
    assert.deepEqual(names.sort(), [
      "gedcom.ged",
      "media/file.pdf",
      "media/photo.png",
    ]);
    const stage = join(dir, "stage");
    await mkdir(stage);
    const parsed = await prepareGenealogyImport(path, stage, "back");
    assert.equal(parsed.family.photos?.length, 1);
    assert.equal(parsed.files.length, 2);
    assert.equal(parsed.family.people[0].photo, parsed.family.photos![0].url);
    assert.deepEqual(parsed.family.photos![0].tags[0], {
      id: "tag",
      personId: "back-p1",
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
    });
    for (const file of parsed.files)
      assert.deepEqual(
        await readFile(join(stage, file.name)),
        file.documentId ? pdf : picture,
      );
    assert.deepEqual(parsed.files.find((f) => f.documentId)?.personIds, [
      "back-p3",
    ]);
    const broken = join(dir, "missing.gdz");
    await zipFile(broken, [["gedcom.ged", Buffer.from(external7)]]);
    await assert.rejects(
      prepareGenealogyImport(broken, stage, "bad"),
      /отсутствует вложение/,
    );
    await assert.rejects(
      writeGenealogyPackage(join(dir, "export-bad.gdz"), uploads, family, [
        { ...media[0], file: "/media/missing.png" },
      ]),
      /ENOENT/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("XML ZIP and base64 load originals; package paths and malformed archives are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-xml-"));
  try {
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const path = join(dir, "test.zip");
    await zipFile(path, [
      ["example.xml", Buffer.from(xml)],
      ["example.xml.files/photo.png", image],
    ]);
    const result = await prepareGenealogyImport(path, dir, "xml");
    assert.equal(result.files.length, 1);
    assert.equal(result.family.people[0].photo, result.family.photos?.[0].url);
    const inline = xml.replace(
      '<details><detail><person id="a" /></detail></details>',
      `<data>${image.toString("base64")}</data>`,
    );
    const xmlPath = join(dir, "inline.xml");
    await writeFile(xmlPath, inline);
    assert.equal(
      (await prepareGenealogyImport(xmlPath, dir, "inline")).files.length,
      1,
    );
    for (const name of [
      "../secret",
      "/secret",
      "C:/secret",
      "media/../secret",
      "media\\file",
      "a//b",
      "a/./b",
    ])
      assert.throws(() => packagePath(name));
    await writeFile(path, Buffer.from("PKbroken"));
    await assert.rejects(prepareGenealogyImport(path, dir, "bad"));
    await zipFile(path, [["gedcom.ged", Buffer.from(external7)]]);
    const damaged = await readFile(path);
    const central = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    damaged.writeUInt32LE(0, central + 16);
    await writeFile(path, damaged);
    await assert.rejects(prepareGenealogyImport(path, dir, "crc"), /CRC/);
    damaged.writeUInt32LE(300 * 1024 * 1024, central + 24);
    await writeFile(path, damaged);
    await assert.rejects(
      prepareGenealogyImport(path, dir, "oversize"),
      /размер/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy UTF-16 decodes, version 7 rejects non-UTF8 and unsupported encodings never become mojibake", () => {
  const ansel = Buffer.concat([
    Buffer.from(
      "0 HEAD\n1 CHAR ANSEL\n1 GEDC\n2 VERS 5.5.1\n0 @I1@ INDI\n1 NAME ",
    ),
    Buffer.from([0xe8, 0x75]),
    Buffer.from(" /Test/\n0 TRLR\n"),
  ]);
  assert.equal(
    importGedcom(decodeGedcom(ansel), "ansel").family.people[0].name,
    "ü",
  );
  const legacy = external7
    .replace("7.0.18", "5.5.1")
    .replace("1 GEDC", "1 CHAR UNICODE\n1 GEDC");
  assert.match(
    decodeGedcom(
      Buffer.concat([Buffer.from([255, 254]), Buffer.from(legacy, "utf16le")]),
    ),
    /Алексей/,
  );
  assert.throws(
    () =>
      decodeGedcom(
        Buffer.concat([
          Buffer.from([255, 254]),
          Buffer.from(external7, "utf16le"),
        ]),
      ),
    /UTF-8/,
  );
  assert.throws(
    () => decodeGedcom(Buffer.from([0xff, 0xff, 0xff])),
    /кодировк/,
  );
});

test("HTTP GEDZIP default, persistent stage, PDF import, rollback and one-time revision-bound token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-transfer-http-")),
    dbPath = join(dir, "archive.sqlite");
  const archive = openArchive(dbPath, seed());
  let actor: ArchiveUser | null = {
    id: "admin",
    name: "Тест",
    role: "admin",
    createdAt: "",
  };
  const auth = { currentUser: () => actor } as unknown as ReturnType<
    typeof createAuth
  >;
  let route = gedcomHttp(archive, auth, dbPath, "https://test.invalid");
  const server = createServer((req, res) => {
    void route.handle(req, res, new URL(req.url!, "https://test.invalid"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, body?: Buffer | object) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { Origin: "https://test.invalid", "X-Drevo-Import": "1" },
      body: Buffer.isBuffer(body)
        ? new Uint8Array(body)
        : body
          ? JSON.stringify(body)
          : undefined,
    });
  try {
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const path = join(dir, "upload.gdz");
    const ged = external7
      .replace(
        "0 TRLR",
        "0 @D@ OBJE\n1 FILE media/document.pdf\n2 FORM application/pdf\n2 TITL Документ\n0 TRLR",
      )
      .replace("1 OBJE @M@", "1 OBJE @M@\n1 OBJE @D@");
    await zipFile(path, [
      ["gedcom.ged", Buffer.from(ged)],
      ["media/photo.png", image],
      ["media/document.pdf", Buffer.from("%PDF-1.4\n%%EOF")],
    ]);
    const response = await request("/api/gedcom/preview", await readFile(path));
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.photos, 1);
    assert.equal(preview.documents, 1);
    route.close();
    route = gedcomHttp(archive, auth, dbPath, "https://test.invalid");
    archive.db.exec(
      "CREATE TRIGGER reject_document BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT,'reject'); END",
    );
    const failed = await request("/api/gedcom/import", {
      token: preview.token,
      confirm: true,
    });
    assert.equal(failed.status, 400);
    assert.equal(archive.read().family.people.length, 3);
    assert.equal((await readdir(join(dir, "uploads"))).length, 0);
    archive.db.exec("DROP TRIGGER reject_document");
    const applied = await request("/api/gedcom/import", {
      token: preview.token,
      confirm: true,
    });
    assert.equal(applied.status, 200, await applied.text());
    assert.equal(archive.read().family.people.length, 5);
    assert.equal(
      archive.db.prepare("SELECT count(*) AS n FROM documents").get()!.n,
      1,
    );
    assert.equal(
      archive.db.prepare("SELECT count(*) AS n FROM document_people").get()!.n,
      1,
    );
    assert.equal(
      (
        await request("/api/gedcom/import", {
          token: preview.token,
          confirm: true,
        })
      ).status,
      400,
    );
    const exported = await request("/api/gedcom/export");
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition")!, /drevo.gdz/);
    const round = await request(
      "/api/gedcom/preview",
      Buffer.from(await exported.arrayBuffer()),
    );
    assert.equal(round.status, 200);
    const second = await round.json();
    assert.equal(second.documents, 1);
    assert.equal(second.photos, 1);
    const current = archive.read();
    archive.write(current.family, current.revision);
    assert.equal(
      (
        await request("/api/gedcom/import", {
          token: second.token,
          confirm: true,
        })
      ).status,
      409,
    );
    actor = { ...actor!, role: "relative" };
    assert.equal((await request("/api/gedcom/export")).status, 403);
    actor = null;
    assert.equal((await request("/api/gedcom/export")).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    route.close();
    archive.close();
    await rm(dir, { recursive: true, force: true });
  }
});
