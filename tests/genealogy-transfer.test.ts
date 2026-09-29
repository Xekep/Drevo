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
import { importAgelongXml } from "../src/domain/agelong-xml.ts";
import { familyMedia } from "../src/domain/genealogy-transfer.ts";
import {
  prepareGenealogyImport,
  writeGenealogyPackage,
  decodeGedcom,
  packagePath,
  exportMedia,
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

test("GEDCOM media export reads document associations in two queries regardless of catalog size", async () => {
  const queries: string[] = [];
  const documents = Array.from({ length: 1000 }, (_, index) => ({
    id: `doc-${index}`,
    title: `Запись ${index}`,
    file_name: `file-${index}.pdf`,
  }));
  const associations = [
    { document_id: "doc-7", person_id: "child" },
    { document_id: "doc-7", person_id: "parent" },
  ];
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      return {
        all: async () =>
          sql.includes("FROM document_people") ? associations : documents,
      };
    },
  } as unknown as Parameters<typeof exportMedia>[0];
  const result = await exportMedia(db, seed());
  assert.equal(queries.length, 2);
  assert.equal(result.length, 1000);
  assert.deepEqual(result[7].personIds, ["child", "parent"]);
  assert.deepEqual(result[8].personIds, []);
});

test("unknown GEDCOM 7 extensions are disclosed without turning hypotheses into facts", () => {
  const input = external7.replace(
    "2 DATE ABT 1900\n",
    "2 DATE ABT 1900\n2 _HYPOTHESIS possible ancestor\n",
  );
  assert.notEqual(input, external7);
  const parsed = importGedcom(input, "unknown-extension");
  assert.ok(parsed.warnings.some((warning) => warning.includes("_HYPOTHESIS")));
  assert.ok(!JSON.stringify(parsed.family).includes("possible ancestor"));
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

test("GEDCOM FAM without marriage keeps shared parents but does not invent spouses", () => {
  const familyRecord = `0 HEAD
1 GEDC
2 VERS 7.0
0 @I1@ INDI
1 NAME Олег /Тестов/
0 @I2@ INDI
1 NAME Ирина /Тестова/
0 @I3@ INDI
1 NAME Маша /Тестова/
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 TRLR
`;
  for (const version of ["7.0", "5.5.1"]) {
    const text = familyRecord.replace("2 VERS 7.0", `2 VERS ${version}`);
    const parsed = importGedcom(text, `parents-${version}`);
    assert.equal(parsed.family.people[2].parents.length, 2);
    assert.deepEqual(parsed.family.people[0].spouses, []);
    assert.deepEqual(parsed.family.people[1].spouses, []);
    assert.ok(
      parsed.warnings.some((warning) =>
        warning.includes("не указано событие брака"),
      ),
    );
    const married = importGedcom(
      text.replace("1 CHIL @I3@", "1 MARR Y\n1 CHIL @I3@"),
      `married-${version}`,
    );
    assert.deepEqual(married.family.people[0].spouses, [
      married.family.people[1].id,
    ]);
  }

  const unmarried = seed();
  unmarried.people[0].spouses = [];
  unmarried.people[1].spouses = [];
  const roundtrip = importGedcom(
    exportGedcom(unmarried, { version: "7.0" }),
    "unmarried-roundtrip",
  );
  assert.equal(roundtrip.family.people[2].parents.length, 2);
  assert.deepEqual(roundtrip.family.people[0].spouses, []);
  assert.ok(
    !roundtrip.warnings.some((warning) =>
      warning.includes("не указано событие брака"),
    ),
  );
});

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

for (const version of ["5.5.1", "7.0"] as const) {
  test(`GEDCOM ${version}: birth surnames use BIRTH for any sex without replacing the current surname`, () => {
    for (const sex of ["f", "m", "u"] as const) {
      const family = seed();
      const person = family.people[0];
      Object.assign(person, {
        name: "Александра",
        surname: "Петрова",
        maidenName: "Иванова",
        sex,
      });
      const text = exportGedcom(family, { version });
      assert.match(
        text,
        version === "7.0" ? /2 TYPE BIRTH\r\n/ : /2 TYPE birth\r\n/,
      );
      assert.doesNotMatch(text, /2 TYPE (?:MAIDEN|maiden)\r\n/);
      const standard = text.replace(
        /^1 _DREVO .*(?:\r?\n2 (?:CONC|CONT).*)*\r?\n/gm,
        "",
      );
      for (const type of ["BIRTH", "birth", "MAIDEN", "maiden"]) {
        const imported = importGedcom(
          standard.replace(/2 TYPE (?:BIRTH|birth)\r\n/, `2 TYPE ${type}\r\n`),
          "surname",
        ).family.people[0];
        assert.equal(imported.surname, "Петрова");
        assert.equal(imported.maidenName, "Иванова");
        assert.doesNotMatch(imported.biography || "", /Другие имена/);
      }
      delete person.maidenName;
      assert.doesNotMatch(
        exportGedcom(family, { version }),
        /2 TYPE (?:BIRTH|birth)\r\n/,
      );
    }
  });

  test(`GEDCOM ${version}: explicit birth name wins over maiden name and legacy fallback`, () => {
    const text = `0 HEAD\n1 GEDC\n2 VERS ${version}\n0 @I1@ INDI\n1 NAME Анна /Петрова/\n1 NAME Анна /Сидорова/\n2 TYPE MAIDEN\n1 NAME Анна /Иванова/\n2 TYPE BIRTH\n1 _MAIDEN Старое значение\n0 TRLR\n`;
    const imported = importGedcom(text, "birth-first").family.people[0];
    assert.equal(imported.surname, "Петрова");
    assert.equal(imported.maidenName, "Иванова");
    assert.match(imported.biography || "", /Сидорова/);
    assert.doesNotMatch(imported.biography || "", /Иванова/);
    const legacy = importGedcom(
      text.replace(
        /1 NAME Анна \/(?:Сидорова|Иванова)\/\n2 TYPE (?:MAIDEN|BIRTH)\n/g,
        "",
      ),
      "legacy",
    ).family.people[0];
    assert.equal(legacy.maidenName, "Старое значение");
  });
}

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version}: source details and place coordinates survive without Drevo metadata`, () => {
    const family = seed();
    const person = family.people[0];
    person.birth = "1900-01-01";
    person.birthPlace = "Мурзинка";
    person.birthLocation = {
      place: "Мурзинка",
      lat: 53.769583333333,
      lon: 67.371222222222,
    };
    person.death = "1980-01-01";
    person.deathLocation = { place: "Казань", lat: -12.5, lon: -44.25 };
    person.events = [
      {
        id: "residence",
        type: "residence",
        place: "Самара",
        location: { place: "Самара", lat: 0, lon: 10.25 },
      },
    ];
    person.sources = [
      {
        title: "Метрическая книга",
        type: "Архив",
        reference: "лист 7",
        url: "https://example.org/archive/7",
        note: "Комментарий архивиста\nВторая строка",
      },
    ];
    const text = exportGedcom(family, { version });
    assert.match(
      text,
      /2 PLAC Мурзинка\r\n3 MAP\r\n4 LATI N53\.769583333333\r\n4 LONG E67\.371222222222/,
    );
    assert.match(
      text,
      /2 PLAC Казань\r\n3 MAP\r\n4 LATI S12\.5\r\n4 LONG W44\.25/,
    );
    assert.match(text, /2 PLAC Самара\r\n3 MAP\r\n4 LATI N0\r\n4 LONG E10\.25/);
    const source = text.split("0 @S1@ SOUR\r\n")[1].split("\r\n0 ")[0];
    assert.match(source, /1 TITL Метрическая книга/);
    assert.match(source, /1 _URL https:\/\/example\.org\/archive\/7/);
    assert.match(source, /1 NOTE URL: https:\/\/example\.org\/archive\/7/);
    assert.match(source, /1 NOTE Комментарий архивиста/);

    // Simulate a reader discarding private Drevo fields before re-export.
    const portable = text
      .replace(/^1 _DREVO .*(?:\r?\n2 (?:CONC|CONT).*)*\r?\n/gm, "")
      .replace(/^1 _URL .*\r?\n/gm, "");
    const imported = importGedcom(portable, "portable").family.people[0];
    assert.equal(imported.sources[0].url, person.sources[0].url);
    assert.equal(imported.sources[0].note, person.sources[0].note);
    assert.deepEqual(imported.birthLocation, person.birthLocation);
    assert.deepEqual(imported.deathLocation, person.deathLocation);
    assert.deepEqual(
      imported.events?.find((event) => event.type === "residence")?.location,
      person.events[0].location,
    );
  });

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version}: all citation transcripts and provenance remain visible`, () => {
    const input = `0 HEAD
1 GEDC
2 VERS ${version}
0 @I1@ INDI
1 NAME Мария /Тестова/
1 BIRT
2 DATE 3 FEB 1900
2 SOUR @S1@
3 PAGE л. 7
3 DATA
4 DATE 4 FEB 1900
4 TEXT Первая строка записи
4 TEXT Вторая строка записи
3 EVEN BIRT
4 ROLE CHIL
3 QUAY 3
0 @S1@ SOUR
1 TITL Метрическая книга
0 TRLR
`;
    const parsed = importGedcom(input, `citation-${version}`);
    const source = parsed.family.people[0].sources[0];
    assert.equal(source.title, "Метрическая книга");
    assert.equal(source.reference, "л. 7");
    for (const detail of [
      "Дата сведений в источнике: 4 FEB 1900",
      "Текст свидетельства 1: Первая строка записи",
      "Текст свидетельства 2: Вторая строка записи",
      "Тип события в цитате: BIRT",
      "Роль в событии: CHIL",
      "Оценка качества цитаты (QUAY): 3",
    ])
      assert.ok(source.note?.includes(detail), detail);
    assert.ok(
      parsed.warnings.some((warning) =>
        warning.includes("сохранены в примечании источника"),
      ),
    );
    const roundtrip = importGedcom(
      exportGedcom(parsed.family, { version }),
      `citation-roundtrip-${version}`,
    );
    assert.equal(roundtrip.family.people[0].sources[0].note, source.note);
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
    family.people[0].maidenName = "Иванова";
    family.people[0].birth = "1900-01-01";
    family.people[0].birthPlace = "Мурзинка";
    family.people[0].birthLocation = {
      place: "Мурзинка",
      lat: 53.75,
      lon: 67.375,
    };
    family.people[0].sources = [
      {
        title: "Метрическая книга",
        type: "Архив",
        reference: "лист 7",
        url: "https://example.org/archive/7",
        note: "Комментарий архивиста",
      },
    ];
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
    let gedcom = "";
    for await (const entry of zip.eachEntry()) {
      names.push(entry.fileName);
      if (entry.fileName === "gedcom.ged") {
        const chunks: Buffer[] = [];
        for await (const chunk of await zip.openReadStreamPromise(entry))
          chunks.push(Buffer.from(chunk));
        gedcom = Buffer.concat(chunks).toString("utf8");
      }
    }
    assert.deepEqual(names.sort(), [
      "gedcom.ged",
      "media/file.pdf",
      "media/photo.png",
    ]);
    assert.match(gedcom, /2 TYPE BIRTH\r\n/);
    const standard = gedcom.replace(
      /^1 _DREVO .*(?:\r?\n2 (?:CONC|CONT).*)*\r?\n/gm,
      "",
    );
    const standardPerson = importGedcom(standard, "gdz-birth").family.people[0];
    assert.equal(standardPerson.surname, family.people[0].surname);
    assert.equal(standardPerson.maidenName, "Иванова");
    assert.match(
      gedcom,
      /2 PLAC Мурзинка\r\n3 MAP\r\n4 LATI N53\.75\r\n4 LONG E67\.375/,
    );
    assert.match(
      gedcom,
      /0 @S1@ SOUR\r\n1 TITL Метрическая книга\r\n1 _TYPE Архив\r\n1 _URL https:\/\/example\.org\/archive\/7\r\n1 NOTE URL: https:\/\/example\.org\/archive\/7\r\n1 NOTE Комментарий архивиста/,
    );
    const stage = join(dir, "stage");
    await mkdir(stage);
    const parsed = await prepareGenealogyImport(path, stage, "back");
    assert.equal(parsed.family.photos?.length, 1);
    assert.equal(parsed.files.length, 2);
    assert.equal(parsed.family.people[0].photo, parsed.family.photos![0].url);
    assert.deepEqual(
      parsed.family.people[0].birthLocation,
      family.people[0].birthLocation,
    );
    assert.equal(
      parsed.family.people[0].sources[0].url,
      family.people[0].sources[0].url,
    );
    assert.equal(
      parsed.family.people[0].sources[0].note,
      family.people[0].sources[0].note,
    );
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

test("GEDZIP preserves photos and PDF documents without person associations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-unlinked-media-"));
  const uploads = join(directory, "uploads");
  const stage = join(directory, "stage");
  try {
    await mkdir(uploads);
    await mkdir(stage);
    const image = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
    await writeFile(join(uploads, "unlinked.png"), image);
    await writeFile(join(uploads, "unlinked.pdf"), pdf);
    const family = seed();
    family.photos = [
      {
        id: "unlinked-photo",
        url: "/media/unlinked.png",
        title: "Без отметок",
        tags: [],
      },
    ];
    const media = [
      ...familyMedia(family),
      {
        id: "unlinked-document",
        file: "documents/unlinked.pdf",
        title: "Документ без привязки",
        mime: "application/pdf",
        personIds: [],
        portraitIds: [],
      },
    ];
    const path = join(directory, "unlinked.gdz");
    await writeGenealogyPackage(path, uploads, family, media);
    const result = await prepareGenealogyImport(path, stage, "unlinked");
    assert.equal(result.family.photos?.length, 1);
    assert.equal(result.family.photos?.[0].title, "Без отметок");
    assert.deepEqual(result.family.photos?.[0].tags, []);
    assert.equal(result.files.length, 2);
    const document = result.files.find((file) => file.documentId);
    assert.equal(document?.title, "Документ без привязки");
    assert.deepEqual(document?.personIds, []);
    assert.deepEqual(await readFile(join(stage, document!.name)), pdf);
    const photo = result.files.find((file) => !file.documentId);
    assert.deepEqual(await readFile(join(stage, photo!.name)), image);
  } finally {
    await rm(directory, { recursive: true, force: true });
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
  const archive = await openArchive(dbPath, seed());
  let actor: ArchiveUser | null = {
    id: "admin",
    name: "Тест",
    role: "admin",
    createdAt: "",
  };
  const auth = { currentUser: () => actor } as unknown as Awaited<
    ReturnType<typeof createAuth>
  >;
  let route = gedcomHttp(archive, auth, dbPath, "https://test.invalid");
  const server = createServer(async (req, res) => {
    void (await route.handle(
      req,
      res,
      new URL(req.url!, "https://test.invalid"),
    ));
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
    await archive.db.exec(
      "CREATE TRIGGER reject_document BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT,'reject'); END",
    );
    const failed = await request("/api/gedcom/import", {
      token: preview.token,
      confirm: true,
    });
    assert.equal(failed.status, 400);
    assert.equal((await archive.read()).family.people.length, 3);
    assert.equal((await readdir(join(dir, "uploads"))).length, 0);
    await archive.db.exec("DROP TRIGGER reject_document");
    const applied = await request("/api/gedcom/import", {
      token: preview.token,
      confirm: true,
    });
    assert.equal(applied.status, 200, await applied.text());
    assert.equal((await archive.read()).family.people.length, 5);
    assert.equal(
      (await archive.db.prepare("SELECT count(*) AS n FROM documents").get())!
        .n,
      1,
    );
    assert.equal(
      (await archive.db
        .prepare("SELECT count(*) AS n FROM document_people")
        .get())!.n,
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
    for (const [format, version] of [
      ["gedcom551", "5.5.1"],
      ["gedcom7", "7.0"],
    ]) {
      const plain = await request(`/api/gedcom/export?format=${format}`);
      assert.equal(plain.status, 200);
      assert.match(plain.headers.get("content-disposition")!, /\.ged"/);
      assert.match(
        await plain.text(),
        new RegExp(`2 VERS ${version.replaceAll(".", "\\.")}`),
      );
    }
    assert.equal(
      (await request("/api/gedcom/export?format=agelongXml")).status,
      400,
    );
    assert.equal(
      (await request("/api/gedcom/export?format=agelongZip")).status,
      400,
    );
    const round = await request(
      "/api/gedcom/preview",
      Buffer.from(await exported.arrayBuffer()),
    );
    assert.equal(round.status, 200);
    const second = await round.json();
    assert.equal(second.documents, 1);
    assert.equal(second.photos, 1);
    const current = await archive.read();
    await archive.write(current.family, current.revision);
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
    await archive.close();
    await rm(dir, { recursive: true, force: true });
  }
});
