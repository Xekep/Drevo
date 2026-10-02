import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  utimes,
  open,
  stat,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import { ZipFile } from "yazl";
import { openPromise } from "yauzl";
import sharp from "sharp";
import { createServer } from "node:http";
import { importGedcom, exportGedcom } from "../src/domain/gedcom.ts";
import { importAgelongXml } from "../src/domain/agelong-xml.ts";
import {
  familyMedia,
  TRANSFER_FILE_LIMIT,
  TRANSFER_PACKAGE_LIMIT,
  TRANSFER_TEXT_LIMIT,
} from "../src/domain/genealogy-transfer.ts";
import { BASIC_MEDIA_BYTES } from "../src/server/postgres-media-quota.ts";
import {
  prepareGenealogyImport,
  writeGenealogyPackage,
  streamGenealogyPackage,
  decodeGedcom,
  packagePath,
  exportMedia,
} from "../src/server/genealogy-package.ts";
import { openArchive } from "../src/server/database.ts";
import { gedcomHttp } from "../src/server/gedcom-http.ts";
import type { createAuth } from "../src/server/auth.ts";
import {
  EXTRA_LINK_TYPES,
  type Family,
  type Person,
} from "../src/domain/types.ts";
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

test("GEDZIP package budget covers the entire basic-account media quota", () => {
  assert.ok(TRANSFER_PACKAGE_LIMIT - TRANSFER_TEXT_LIMIT >= BASIC_MEDIA_BYTES);
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
  assert.deepEqual(result[7].document, {
    documentType: "",
    documentDate: "",
    place: "",
    description: "",
    provenance: "",
  });
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
for (const version of ["5.5.1", "7.0"] as const) {
  test(`GEDCOM ${version} preserves every additional relationship without inventing blood parents`, () => {
    const family: Family = {
      ...seed(),
      people: EXTRA_LINK_TYPES.flatMap((_, index) => [
        person(`giver-${index}`),
        person(`receiver-${index}`),
      ]),
      links: EXTRA_LINK_TYPES.map((type, index) => ({
        id: `link-${index}`,
        from: `giver-${index}`,
        to: `receiver-${index}`,
        type,
        note: `Источник связи ${index}`,
        ...(type === "twin" ? { twinKind: "fraternal" as const } : {}),
      })),
    };
    const imported = importGedcom(
      exportGedcom(family, { version }),
      "extra-links",
    );
    const byId = new Map(imported.family.people.map((item) => [item.id, item]));
    const links = (imported.family.links || []).map((link) => ({
      from: byId.get(link.from)?.name,
      to: byId.get(link.to)?.name,
      type: link.type,
      note: link.note,
      twinKind: link.twinKind,
    }));
    assert.deepEqual(
      links,
      EXTRA_LINK_TYPES.map((type, index) => ({
        from: `giver-${index}`,
        to: `receiver-${index}`,
        type,
        note: `Источник связи ${index}`,
        twinKind: type === "twin" ? "fraternal" : undefined,
      })),
    );
    assert.ok(
      imported.family.people.every((item) => item.parents.length === 0),
    );
  });
  test(`GEDCOM ${version} preserves explicitly recorded twin type`, () => {
    const family = seed();
    family.links = [
      {
        id: "twins",
        from: "parent",
        to: "partner",
        type: "twin",
        twinKind: "identical",
      },
    ];
    const text = exportGedcom(family, { version });
    assert.match(text, /2 _DREVO_TWIN identical/);
    const imported = importGedcom(text, "twins");
    assert.equal(imported.family.links?.[0].type, "twin");
    assert.equal(imported.family.links?.[0].twinKind, "identical");
  });
}
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
  test(`GEDCOM ${version}: repository name and call number remain with a cited source`, () => {
    const external = `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS ${version}
0 @I1@ INDI
1 NAME Анна /Тестова/
1 SOUR @S1@
1 BIRT
2 DATE 1900
2 SOUR @S1@
3 PAGE л. 3
0 @S1@ SOUR
1 TITL Метрическая книга
1 REPO @R1@
2 CALN Ф. 6, оп. 13, д. 104
0 @R1@ REPO
1 NAME ГАСО
0 TRLR`;
    const imported = importGedcom(external, `repository-${version}`);
    const personCitation = imported.family.people[0].sources?.[0];
    assert.equal(personCitation?.reference, "");
    assert.deepEqual(personCitation?.repository, {
      name: "ГАСО", callNumber: "Ф. 6, оп. 13, д. 104",
      website: "", note: "", linkNote: "",
    });
    const citation = imported.family.people[0].events?.find((event) =>
      event.gedcomTag === "BIRT")?.sources?.[0];
    assert.equal(citation?.reference, "л. 3");
    assert.deepEqual(citation?.repository, personCitation?.repository);
    assert.ok(!imported.warnings.some((warning) => warning.includes("структура REPO")));
    assert.ok(!imported.warnings.some((warning) => warning.includes("Запись REPO") && warning.includes("не перенесена")));
    const exported = exportGedcom(imported.family, { version });
    assert.doesNotMatch(exported, /2 PAGE Ф\. 6, оп\. 13, д\. 104/);
    const restored = importGedcom(exported, `repository-again-${version}`);
    assert.equal(restored.family.people[0].sources?.[0].reference, personCitation?.reference);
    assert.deepEqual(restored.family.people[0].sources?.[0].repository, personCitation?.repository);
    assert.deepEqual(restored.family.people[0].events?.find((event) =>
      event.gedcomTag === "BIRT")?.sources?.[0].repository, citation?.repository);
    assert.match(exported, /1 REPO @R\d+@\r?\n2 CALN Ф\. 6, оп\. 13, д\. 104/);
    assert.match(exported, /0 @R\d+@ REPO\r?\n1 NAME ГАСО/);
  });

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version}: repository website and notes stay with each paged citation`, () => {
    const external = `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS ${version}
0 @I1@ INDI
1 NAME Анна /Тестова/
1 BIRT
2 DATE 1900
2 SOUR @S1@
3 PAGE л. 3
3 NOTE Запись о рождении
1 DEAT
2 DATE 1980
2 SOUR @S1@
3 PAGE л. 9
3 NOTE Запись о смерти
0 @S1@ SOUR
1 TITL Метрическая книга
1 NOTE URL: https://archive.example.org/book/104
1 REPO @R1@
2 CALN Ф. 6, оп. 13, д. 104
2 NOTE Выдаётся в читальном зале
0 @R1@ REPO
1 NAME ГАСО
1 WWW https://archive.example.org
1 NOTE Предварительная запись обязательна
0 TRLR`;
    const citations = importGedcom(external, `repository-notes-${version}`)
      .family.people[0].events?.filter((event) => ["BIRT", "DEAT"].includes(event.gedcomTag || ""))
      .map((event) => event.sources?.[0]);
    assert.deepEqual(citations?.map((source) => source?.reference), ["л. 3", "л. 9"]);
    assert.deepEqual(citations?.map((source) => source?.url), [
      "https://archive.example.org/book/104", "https://archive.example.org/book/104",
    ]);
    for (const source of citations || []) {
      assert.deepEqual(source?.repository, {
        name: "ГАСО", callNumber: "Ф. 6, оп. 13, д. 104",
        website: "https://archive.example.org",
        note: "Предварительная запись обязательна",
        linkNote: "Выдаётся в читальном зале",
      });
    }
    assert.match(citations?.[0]?.note || "", /Запись о рождении/);
    assert.doesNotMatch(citations?.[0]?.note || "", /Запись о смерти/);
    assert.match(citations?.[1]?.note || "", /Запись о смерти/);
    assert.doesNotMatch(citations?.[1]?.note || "", /Запись о рождении/);
    const exported = exportGedcom(importGedcom(external, `repository-export-${version}`).family, { version })
      .replace(/^1 _DREVO .*(?:\r?\n2 (?:CONC|CONT).*)*\r?\n/gm, "");
    const restored = importGedcom(exported, `repository-restored-${version}`).family.people[0]
      .events?.filter((event) => ["BIRT", "DEAT"].includes(event.gedcomTag || ""))
      .map((event) => event.sources?.[0]);
    assert.deepEqual(restored?.map((source) => source?.reference), ["л. 3", "л. 9"]);
    assert.deepEqual(restored?.map((source) => source?.url), [
      "https://archive.example.org/book/104", "https://archive.example.org/book/104",
    ]);
    assert.deepEqual(restored?.map((source) => source?.repository),
      citations?.map((source) => source?.repository));
    assert.match(restored?.[0]?.note || "", /Запись о рождении/);
    assert.doesNotMatch(restored?.[0]?.note || "", /Запись о смерти/);
    assert.match(restored?.[1]?.note || "", /Запись о смерти/);
    assert.doesNotMatch(restored?.[1]?.note || "", /Запись о рождении/);
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
<person id="c" sex="М" fn="Иван" sn="Тестов" bdate="03.02.1930"><bplace id="mos">Москва</bplace><nearest><person id="b" relcode="F" /></nearest></person>
</persons><events>
<event id="birth" type="Рождение" date="03.02.1930"><place id="mos">Москва</place><persons><person id="c" role="Родился" /><person id="a" role="Отец" /><person id="b" role="Мать" /></persons></event>
<event id="union" type="Свадьба" date="1925" institution="Сельсовет"><persons><person id="a" role="Муж" /><person id="b" role="Жена" /></persons></event>
<event id="trip" type="Поездка" date="1931" coords="55.7, 37.6" custom="value"><place id="mos">Москва</place><persons><person id="a" role="Участник" /></persons></event>
</events><places><place id="mos" fullname="Москва" coords="55.7558, 37.6173" /></places><documents><document id="d" path="example.xml.files/photo.png" title="Портрет"><details><detail><person id="a" /></detail></details></document></documents><families><family id="x" /></families></agelongtree>`;

test("Agelong XML uses event roles, preserves uncertainty and escapes; rejects entities and dangling people", () => {
  const result = importAgelongXml(xml, "xml");
  assert.deepEqual(result.family.people[2].parents, ["xml-p1", "xml-p2"]);
  assert.equal(result.family.people[2].birth, "1930-02-03");
  assert.equal(result.family.people[2].birthPlace, "Москва");
  assert.deepEqual(result.family.people[2].birthLocation, {
    place: "Москва", lat: 55.7558, lon: 37.6173,
  });
  assert.equal(result.family.people[0].birth, "");
  assert.equal(result.family.people[0].events?.[0].dateText, "Около 1900");
  assert.equal(result.family.people[0].biography, "Текст & <заметка>");
  assert.equal(result.family.people[0].spouses[0], "xml-p2");
  assert.match(result.family.people[0].events!.find((event) => event.type === "marriage")!.description!, /Учреждение: Сельсовет/);
  assert.deepEqual(result.family.people[0].events!.find((event) => event.title === "Поездка")!.location, {
    place: "Москва", lat: 55.7, lon: 37.6,
  });
  assert.ok(result.warnings.some((warning) => warning.includes("Поле event.custom сохранено как текст")));
  assert.match(result.family.people[0].events!.find((event) => event.title === "Поездка")!.description!, /custom: value/);
  assert.deepEqual(result.media[0].portraitIds, ["xml-p1"]);
  const deathDetails = importAgelongXml(
    xml.replace("</events>", '<event id="death" type="Смерть" date="1940" deathreason="Болезнь"><persons><person id="a" role="Умер" /></persons></event></events>'),
    "death-details",
  );
  assert.match(deathDetails.family.people[0].biography!, /Причина смерти: Болезнь/);
  const badCoordinates = importAgelongXml(xml.replace('coords="55.7, 37.6"', 'coords="999, 37.6"'), "invalid-coordinates");
  assert.equal(badCoordinates.family.people[0].events!.find((event) => event.title === "Поездка")!.location, undefined);
  assert.ok(badCoordinates.warnings.some((warning) => warning.startsWith("Координаты события")));
  const placeMetadata = importAgelongXml(
    xml.replace('fullname="Москва" coords=', 'fullname="Москва" name="Москва" nameshort="Москва" date="1900" coords=')
      .replace('coords="55.7558, 37.6173" />', 'coords="55.7558, 37.6173"><parent_id id="region" /></place>'),
    "place-metadata",
  );
  assert.ok(placeMetadata.warnings.some((warning) => warning.includes("Даты исторических названий мест (1)")));
  assert.ok(placeMetadata.warnings.some((warning) => warning.includes("Иерархия родительских мест (1)")));
  assert.ok(!placeMetadata.warnings.some((warning) => warning.includes("Альтернативные названия мест")));
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

test("Agelong XML keeps people, relationships, coordinates and events through GEDCOM 7", () => {
  const source = importAgelongXml(xml, "agelong-roundtrip").family;
  const restored = importGedcom(
    exportGedcom(source, { version: "7.0" }),
    "gedcom-roundtrip",
  ).family;
  assert.equal(restored.people.length, source.people.length);
  assert.equal(
    restored.people.reduce((total, person) => total + person.parents.length, 0),
    source.people.reduce((total, person) => total + person.parents.length, 0),
  );
  assert.deepEqual(restored.people[2].birthLocation, source.people[2].birthLocation);
  assert.deepEqual(
    restored.people[0].events?.find((event) => event.title === "Поездка")?.location,
    source.people[0].events?.find((event) => event.title === "Поездка")?.location,
  );
  assert.match(
    restored.people[0].events?.find((event) => event.type === "marriage")?.description || "",
    /Учреждение: Сельсовет/,
  );
});

test("Agelong XML attaches former-spouse divorce to the right marriage regardless of event order", () => {
  const input = `<agelongtree><persons>
    <person id="a" fn="Anna" sn="Example"/><person id="b" fn="Boris" sn="Example"/>
    <person id="c" fn="Clara" sn="Example"/>
    </persons><events>
    <event id="divorce" type="Развод" date="1930"><persons><person id="a" role="Бывшая жена"/><person id="b" role="Бывший муж"/></persons></event>
    <event id="other" type="Свадьба" date="1925"><persons><person id="b" role="Муж"/><person id="c" role="Жена"/></persons></event>
    <event id="marriage" type="Свадьба" date="1920"><persons><person id="a" role="Жена"/><person id="b" role="Муж"/></persons></event>
    </events></agelongtree>`;
  const imported = importAgelongXml(input, "divorce");
  assert.equal(imported.family.unions?.length, 2);
  const former = imported.family.unions?.find((union) => union.divorce);
  assert.deepEqual(former?.participants.sort(), ["divorce-p1", "divorce-p2"]);
  assert.equal(former?.formation?.date, "1920");
  assert.equal(former?.divorce?.date, "1930");
  assert.ok(imported.family.people[0].events?.some((event) => event.type === "divorce"));
  const restored = importGedcom(exportGedcom(imported.family, { version: "7.0" }), "restored");
  assert.equal(restored.family.unions?.find((union) => union.divorce)?.divorce?.date, "1930");
  assert.equal(restored.family.unions?.find((union) => union.divorce)?.formation?.date, "1920");
  assert.notEqual(importAgelongXml(input, "another").family.unions?.[0].id, imported.family.unions?.[0].id);
});

test("Agelong XML reports ambiguous divorces rather than selecting a marriage", () => {
  const input = `<agelongtree><persons><person id="a" fn="Anna" sn="Example"/>
    <person id="b" fn="Boris" sn="Example"/></persons><events>
    <event id="one" type="Свадьба"><persons><person id="a" role="Жена"/><person id="b" role="Муж"/></persons></event>
    <event id="two" type="Свадьба"><persons><person id="a" role="Жена"/><person id="b" role="Муж"/></persons></event>
    <event id="divorce" type="Развод"><persons><person id="a" role="Бывшая жена"/><person id="b" role="Бывший муж"/></persons></event>
    </events></agelongtree>`;
  const imported = importAgelongXml(input, "ambiguous");
  assert.equal(imported.family.unions?.length, 3);
  assert.ok(imported.warnings.some((warning) => warning.includes("Развод divorce сохранён отдельным союзом: у пары несколько возможных союзов")));
});

test("Agelong XML reports a divorce with no compatible marriage and keeps it separate", () => {
  const input = `<agelongtree><persons><person id="a" fn="Anna" sn="Example"/>
    <person id="b" fn="Boris" sn="Example"/></persons><events>
    <event id="divorce" type="Развод" date="1930"><persons><person id="a" role="Бывшая жена"/><person id="b" role="Бывший муж"/></persons></event>
    <event id="later" type="Свадьба" date="1940"><persons><person id="a" role="Жена"/><person id="b" role="Муж"/></persons></event>
    </events></agelongtree>`;
  const imported = importAgelongXml(input, "unmatched");
  assert.equal(imported.family.unions?.length, 2);
  assert.equal(imported.family.unions?.find((union) => union.divorce)?.formation, undefined);
  assert.equal(imported.family.unions?.find((union) => union.formation)?.divorce, undefined);
  assert.ok(imported.warnings.some((warning) => warning.includes("Развод divorce сохранён отдельным союзом: подходящий брак не найден")));
});

test("Agelong XML retains cited sources and custom values while disclosing lost structure", () => {
  const input = `<agelongtree><persons>
    <person id="p" fn="Анна" sn="Примерова" nickname="Нюра" fav="1">
      <family id="group"/><fields><field name="Прозвище">Домашнее имя</field></fields>
      <sources><source id="s" page="17"/></sources>
    </person></persons><events>
    <event id="job" type="Работа" salary="10"><persons><person id="p" role="Работник"/></persons>
      <sources><source id="s"/></sources></event>
    </events><sources>
      <source id="s" title="Архивная книга" type="рукопись" reference="Ф. 1" author="Автор"><comment>Лист 3</comment></source>
      <source id="orphan" title="Без ссылки"/>
    </sources><families><family id="group" name="Род Примеровых"/></families></agelongtree>`;
  const result = importAgelongXml(input, "extra");
  const person = result.family.people[0];
  assert.match(person.biography!, /Род в «Древе Жизни»: Род Примеровых/);
  assert.match(person.biography!, /Флаг избранного в «Древе Жизни»: 1/);
  assert.match(person.biography!, /nickname: Нюра/);
  assert.match(person.biography!, /person.fields.field.name: Прозвище/);
  assert.match(person.biography!, /person.fields.field: Домашнее имя/);
  assert.equal(person.sources[0].title, "Архивная книга");
  assert.equal(person.sources[0].reference, "Ф. 1");
  assert.match(person.sources[0].note!, /author: Автор/);
  assert.match(person.sources[0].note!, /page: 17/);
  const event = person.events!.find((item) => item.title === "Работа")!;
  assert.match(event.description!, /salary: 10/);
  assert.equal(event.sources?.[0].title, "Архивная книга");
  assert.ok(result.warnings.some((warning) => warning.includes("Источники без ссылок на людей или события (1)")));
  assert.ok(result.warnings.some((warning) => warning.includes("структура и дополнительные свойства")));
  assert.ok(result.warnings.some((warning) => warning.includes("отдельного признака избранного")));
});

test("Agelong XML preserves a family-only photo's group name through GEDZIP", async () => {
  const xml = `<agelongtree><persons><person id="p" fn="Anna" sn="Example"/></persons>
    <documents><document id="d" path="archive.xml.files/group.png" title="Group photo">
      <details><detail><family id="f"/></detail></details></document></documents>
    <families><family id="f" name="Example lineage"><documents><document id="d"/></documents></family></families>
    </agelongtree>`;
  const directory = await mkdtemp(join(tmpdir(), "drevo-xml-family-photo-"));
  try {
    const fromFamilyList = importAgelongXml(
      xml.replace('<details><detail><family id="f"/></detail></details>', ""),
      "family-list-only",
    );
    assert.equal(fromFamilyList.media[0].photo?.description, "Род в «Древе Жизни»: Example lineage");
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "blue" },
    }).png().toBuffer();
    const input = join(directory, "input.zip");
    await zipFile(input, [
      ["archive.xml", Buffer.from(xml)],
      ["archive.xml.files/group.png", image],
    ]);
    const stage = join(directory, "stage");
    await mkdir(stage);
    const prepared = await prepareGenealogyImport(input, stage, "xml-family-photo");
    assert.equal(prepared.files.length, 1);
    assert.deepEqual(prepared.files[0].personIds, []);
    assert.equal(prepared.family.photos?.[0].description, "Род в «Древе Жизни»: Example lineage");
    assert.deepEqual(prepared.family.photos?.[0].tags, []);
    assert.ok(prepared.warnings.some((warning) => warning.includes("Связи 1 документов с родами сохранены текстом")));

    const exported = join(directory, "roundtrip.gdz");
    await writeGenealogyPackage(exported, stage, prepared.family, familyMedia(prepared.family));
    const restoredStage = join(directory, "restored");
    await mkdir(restoredStage);
    const restored = await prepareGenealogyImport(exported, restoredStage, "gedzip-family-photo");
    assert.equal(restored.family.photos?.[0].description, "Род в «Древе Жизни»: Example lineage");
    assert.deepEqual(restored.family.photos?.[0].tags, []);
    assert.equal(restored.files.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agelong XML retains an event's PDF attachment as a linked document", async () => {
  const input = `<agelongtree><persons><person id="p" fn="Anna" sn="Example" /></persons>
    <events><event id="school" type="Education" date="1920"><persons><person id="p" role="Student"/></persons>
      <documents><document id="certificate"/></documents></event></events>
    <documents><document id="certificate" path="archive.xml.files/certificate.pdf" title="School certificate"/></documents>
    </agelongtree>`;
  const result = importAgelongXml(input, "xml-document-event");
  const eventId = result.family.people[0].events?.find((event) => event.title === "Education")?.id;
  assert.ok(eventId);
  assert.deepEqual(result.media[0].personIds, ["xml-document-event-p1"]);
  assert.deepEqual(result.media[0].document?.eventLinks, [
    { personId: "xml-document-event-p1", eventId },
  ]);
  assert.ok(!result.warnings.some((warning) => warning.includes("не переносит связи документов")));
  const directory = await mkdtemp(join(tmpdir(), "drevo-xml-event-document-"));
  try {
    const archive = join(directory, "archive.zip");
    const stage = join(directory, "stage");
    await mkdir(stage);
    await zipFile(archive, [
      ["family.xml", Buffer.from(input)],
      ["archive.xml.files/certificate.pdf", Buffer.from("%PDF-1.4\nattached-original")],
    ]);
    const prepared = await prepareGenealogyImport(archive, stage, "xml-staged");
    const stagedEventId = prepared.family.people[0].events?.find((event) => event.title === "Education")?.id;
    assert.equal(prepared.files.length, 1);
    assert.ok(prepared.files[0].documentId);
    assert.deepEqual(prepared.files[0].personIds, ["xml-staged-p1"]);
    assert.deepEqual(prepared.files[0].document?.eventLinks, [
      { personId: "xml-staged-p1", eventId: stagedEventId },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const portrait = importAgelongXml(
    input.replace('path="archive.xml.files/certificate.pdf"', 'path="archive.xml.files/portrait.png"')
      .replace('<person id="p" fn="Anna" sn="Example" />',
        '<person id="p" fn="Anna" sn="Example"><documents><document id="certificate" ismain="1"/></documents></person>'),
    "xml-image-event",
  );
  assert.equal(portrait.media[0].document, undefined);
  assert.deepEqual(portrait.media[0].portraitIds, ["xml-image-event-p1"]);
  assert.ok(portrait.warnings.some((warning) => warning.includes("не переносит связи некоторых документов")));
});

test("Agelong XML preserves a PDF document comment through ZIP staging", async () => {
  const xml = `<agelongtree><persons><person id="p" fn="Anna" sn="Example">
    <documents><document id="letter"/></documents></person></persons>
    <documents><document id="letter" path="archive.xml.files/letter.pdf" title="Family letter" custom="box 4">
      <comment>Handwritten note on the reverse</comment></document></documents></agelongtree>`;
  const directory = await mkdtemp(join(tmpdir(), "drevo-xml-document-comment-"));
  try {
    const archive = join(directory, "archive.zip");
    const stage = join(directory, "stage");
    await mkdir(stage);
    await zipFile(archive, [
      ["family.xml", Buffer.from(xml)],
      ["archive.xml.files/letter.pdf", Buffer.from("%PDF-1.4\nletter-original")],
    ]);
    const prepared = await prepareGenealogyImport(archive, stage, "xml-comment");
    assert.equal(prepared.files.length, 1);
    assert.ok(prepared.files[0].documentId);
    assert.equal(prepared.files[0].document?.description,
      "Handwritten note on the reverse\ncustom: box 4");
    assert.deepEqual(prepared.files[0].personIds, ["xml-comment-p1"]);
    const longXml = xml
      .replace('path="archive.xml.files/letter.pdf" ', "")
      .replace("Handwritten note on the reverse", "x".repeat(1100))
      .replace("</comment>", `</comment><data>${Buffer.from("%PDF-1.4\nembedded").toString("base64")}</data>`);
    const embeddedPath = join(directory, "embedded.xml");
    const embeddedStage = join(directory, "embedded-stage");
    await writeFile(embeddedPath, longXml);
    await mkdir(embeddedStage);
    const embedded = await prepareGenealogyImport(embeddedPath, embeddedStage, "xml-embedded-comment");
    assert.equal(embedded.files[0].document?.description.length, 1000);
    assert.ok(embedded.warnings.some((warning) => warning.includes("сокращено до 1000 символов")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const image = importAgelongXml(
    xml.replace("archive.xml.files/letter.pdf", "archive.xml.files/letter.png"),
    "xml-image-comment",
  );
  assert.equal(image.media[0].document, undefined);
  assert.match(image.media[0].photo?.description || "", /Handwritten note on the reverse/);
});

test("Agelong XML keeps a mislabeled event image as a portrait after checking its bytes", async () => {
  const xml = `<agelongtree><persons><person id="p" fn="Anna" sn="Example">
    <documents><document id="scan" ismain="1"/></documents></person></persons>
    <events><event id="school" type="Education"><persons><person id="p" role="Student"/></persons>
      <documents><document id="scan"/></documents></event></events>
    <documents><document id="scan" path="archive.xml.files/scan.pdf" title="Mislabeled scan"/></documents>
    </agelongtree>`;
  const directory = await mkdtemp(join(tmpdir(), "drevo-xml-mislabeled-image-"));
  try {
    const archive = join(directory, "archive.zip");
    const stage = join(directory, "stage");
    await mkdir(stage);
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer();
    await zipFile(archive, [
      ["family.xml", Buffer.from(xml)],
      ["archive.xml.files/scan.pdf", image],
    ]);
    const prepared = await prepareGenealogyImport(archive, stage, "xml-mislabeled");
    assert.equal(prepared.files[0].documentId, undefined);
    assert.equal(prepared.family.photos?.length, 1);
    assert.equal(prepared.family.people[0].photo, prepared.family.photos?.[0].url);
    assert.ok(prepared.warnings.some((warning) => warning.includes("связь с событием не перенесена")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function zipFile(path: string, entries: [string, Buffer][]) {
  const zip = new ZipFile(),
    writing = pipeline(zip.outputStream, createWriteStream(path));
  for (const [name, bytes] of entries) zip.addBuffer(bytes, name);
  zip.end();
  await writing;
}

function replaceZipEntryName(
  bytes: Buffer,
  original: string,
  replacement: string,
) {
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(replacement));
  const needle = Buffer.from(original);
  const value = Buffer.from(replacement);
  let count = 0;
  for (let offset = 0; ;) {
    const index = bytes.indexOf(needle, offset);
    if (index < 0) break;
    value.copy(bytes, index);
    count++;
    offset = index + needle.length;
  }
  assert.equal(count, 2); // local header and central directory
  return bytes;
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
    const pdf = Buffer.alloc(50 * 1024 * 1024, 32);
    pdf.write("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
    await writeFile(join(uploads, "photo.png"), picture);
    await writeFile(join(uploads, "file.pdf"), pdf);
    const tiff = Buffer.concat([await sharp({ create: { width: 20, height: 90, pageHeight: 30, channels: 3, background: "green" } }).tiff().toBuffer(), Buffer.alloc(21 * 1024 * 1024)]);
    await writeFile(join(uploads, "scan.tif"), tiff);
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
        document: {
          documentType: "Метрическая запись",
          documentDate: "1887 год",
          place: "Мурзинка",
          description: "Лист 7",
          provenance: "ГАСО, Ф. 6",
          pages: [{ number: 7, description: "Рождение Анны Ивановой" }],
        },
      },
    ];
    const path = join(dir, "test.gdz");
    media.push({ ...media[1], id: "tiff", file: "documents/scan.tif", mime: "image/tiff", title: "TIFF",
      document: { ...media[1].document!, pages: [{ number: 2, description: "Продолжение записи" }] } });
    for (const version of ["5.5.1", "7.0"] as const) {
      const text = exportGedcom(family, { version, media });
      const plain = importGedcom(text, `pages-${version}`);
      assert.deepEqual(plain.media.find((item) => item.title === "Запись")?.document?.pages,
        media[1].document?.pages);
      assert.deepEqual(plain.media.find((item) => item.title === "TIFF")?.document?.pages,
        media[2].document?.pages);
      assert.throws(() => importGedcom(text.replace('"number":7', '"number":0'), `bad-pages-${version}`),
        /Повреждены сведения о медиа Drevo/);
    }
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
      "media/scan.tif",
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
    assert.equal(parsed.files.length, 3);
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
        file.name.endsWith(".tif") ? tiff : file.documentId ? pdf : picture,
      );
    assert.ok(parsed.files.find(file => file.name.endsWith(".tif"))?.documentId);
    assert.deepEqual(parsed.files.find((f) => f.documentId)?.personIds, [
      "back-p3",
    ]);
    assert.deepEqual(
      parsed.files.find((f) => f.documentId)?.document,
      media[1].document,
    );
    assert.deepEqual(parsed.files.find((f) => f.name.endsWith(".tif"))?.document?.pages,
      media[2].document?.pages);
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

test("GEDZIP retains a scanned image as a document rather than a gallery photo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-scan-gdz-"));
  try {
    const uploads = join(dir, "uploads");
    const stage = join(dir, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const scan = await sharp({ create: {
      width: 24, height: 32, channels: 3, background: "#e2decf",
    } }).png().toBuffer();
    await writeFile(join(uploads, "scan.png"), scan);
    const details = {
      documentType: "Метрическая запись", documentDate: "1887",
      place: "Реж", description: "Лист 7", provenance: "ГАСО",
    };
    const path = join(dir, "scan.gdz");
    await writeGenealogyPackage(path, uploads, seed(), [{
      id: "scan", file: "documents/scan.png", title: "Скан записи",
      mime: "image/png", personIds: ["child"], portraitIds: [],
      document: details,
    }]);
    const parsed = await prepareGenealogyImport(path, stage, "scan-import");
    assert.deepEqual(parsed.family.photos || [], []);
    assert.equal(parsed.files.length, 1);
    assert.ok(parsed.files[0].documentId);
    assert.deepEqual(parsed.files[0].document, details);
    assert.deepEqual(parsed.files[0].personIds, ["scan-import-p3"]);
    assert.deepEqual(await readFile(join(stage, parsed.files[0].name)), scan);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("streamed GEDZIP validates originals before starting the response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-stream-export-"));
  const uploads = join(directory, "uploads");
  try {
    await mkdir(uploads);
    await writeFile(join(uploads, "photo.png"), Buffer.from("original bytes"));
    const family: Family = {
      title: "Archive",
      description: "",
      demo: false,
      people: [],
      photos: [
        { id: "photo", url: "/media/photo.png", title: "Photo", tags: [] },
      ],
    };
    const packageFile = join(directory, "stream.gdz");
    let ready = false;
    await streamGenealogyPackage(
      createWriteStream(packageFile),
      uploads,
      family,
      familyMedia(family),
      async () => {
        ready = true;
      },
    );
    assert.equal(ready, true);
    const zip = await openPromise(packageFile);
    const names: string[] = [];
    for await (const entry of zip.eachEntry()) names.push(entry.fileName);
    assert.deepEqual(names.sort(), ["gedcom.ged", "media/photo.png"]);

    const original = await open(join(uploads, "photo.png"), "r+");
    try {
      await original.truncate(TRANSFER_FILE_LIMIT + 1);
    } finally {
      await original.close();
    }
    const largePackage = join(directory, "large.gdz");
    await streamGenealogyPackage(
      createWriteStream(largePackage),
      uploads,
      family,
      familyMedia(family),
      async () => {},
    );
    assert.ok((await stat(largePackage)).size > TRANSFER_FILE_LIMIT);

    const output = new PassThrough();
    let bytes = 0;
    output.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    ready = false;
    await assert.rejects(
      streamGenealogyPackage(
        output,
        uploads,
        family,
        [{ ...familyMedia(family)[0], file: "/media/missing.png" }],
        async () => {
          ready = true;
        },
      ),
      /ENOENT/,
    );
    assert.equal(ready, false);
    assert.equal(bytes, 0);
    output.destroy();
  } finally {
    await rm(directory, { recursive: true, force: true });
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
    assert.deepEqual(result.family.people[2].birthLocation, {
      place: "Москва", lat: 55.7558, lon: 37.6173,
    });
    assert.ok(result.warnings.some((warning) => warning.includes("Поле event.custom сохранено как текст")));
    const windowsZip = replaceZipEntryName(
      await readFile(path),
      "example.xml.files/photo.png",
      "example.xml.files\\photo.png",
    );
    await writeFile(path, windowsZip);
    const windowsImport = await prepareGenealogyImport(path, dir, "windows");
    assert.equal(windowsImport.files.length, 1);
    assert.equal(windowsImport.family.photos?.length, 1);
    await zipFile(path, [
      ["example.xml", Buffer.from(xml)],
      ["media/ok/photo.png", image],
    ]);
    const traversal = replaceZipEntryName(
      await readFile(path),
      "media/ok/photo.png",
      "media\\..\\photo.png",
    );
    await writeFile(path, traversal);
    await assert.rejects(
      prepareGenealogyImport(path, dir, "traversal"),
      /invalid relative path|Недопустимый путь/,
    );
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

test("GEDCOM and GEDZIP retain cited documents for alternative fact values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-alternative-citations-"));
  const documentId = "11111111-1111-4111-8111-111111111111";
  const family = seed();
  family.people[0].birth = "1880";
  family.people[0].birthPlace = "Москва";
  family.people[0].sources = [{ title: "Метрическая запись", type: "archive",
    reference: "л. 4", documentId, documentPage: 2 }];
  family.people[0].factAlternatives = [
    { id: "birth-variant", field: "birth", value: "1881", sources: [{
      title: "Метрическая запись", type: "archive", reference: "л. 4",
      documentId, documentPage: 4,
    }] },
    { id: "place-variant", field: "birthPlace", value: "Тула", sources: [{
      title: "Метрическая запись", type: "archive", reference: "л. 9",
      documentId, documentPage: 9,
    }] },
  ];
  const media = [{ id: documentId, file: "documents/record.pdf", title: "Метрическая запись",
    mime: "application/pdf", personIds: [], portraitIds: [],
    document: { documentType: "record", documentDate: "", place: "",
      description: "", provenance: "" } }];
  try {
    for (const version of ["5.5.1", "7.0"] as const) {
      const parsed = importGedcom(exportGedcom(family, { version, media }), `alternative-${version}`);
      assert.deepEqual(parsed.citationMedia?.map(({ page }) => page), [2, 4, 9]);
      assert.equal(parsed.family.people[0].sources.length, 1);
      assert.deepEqual([parsed.family.people[0].sources[0],
        ...parsed.family.people[0].factAlternatives!.flatMap((item) => item.sources)],
      parsed.citationMedia?.map(({ source }) => source));
    }
    const uploads = join(dir, "uploads");
    const stage = join(dir, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const bytes = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
    await writeFile(join(uploads, "record.pdf"), bytes);
    const path = join(dir, "alternative.gdz");
    await writeGenealogyPackage(path, uploads, family, media);
    const restored = await prepareGenealogyImport(path, stage, "alternative-package");
    assert.equal(restored.files.length, 1, "one original shared by two citations");
    const importedId = restored.files[0].documentId;
    assert.ok(importedId && importedId !== documentId);
    assert.deepEqual(restored.family.people[0].sources.map((source) =>
      [source.documentId, source.documentPage]), [[importedId, 2]]);
    assert.deepEqual(restored.family.people[0].factAlternatives?.map((item) =>
      item.sources.map((source) => [source.documentId, source.documentPage])),
    [[[importedId, 4]], [[importedId, 9]]]);
    assert.deepEqual(await readFile(join(stage, restored.files[0].name)), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visible GEDZIP restores documents cited by retained people, events, claims and unions only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-visible-citations-"));
  const dbPath = join(dir, "archive.sqlite");
  const family = seed();
  const documents = [
    ["claim", "11111111-1111-4111-8111-111111111111"],
    ["union", "22222222-2222-4222-8222-222222222222"],
    ["excluded", "33333333-3333-4333-8333-333333333333"],
  ] as const;
  const source = (documentId: string, documentPage = 1) => ({
    title: `Source ${documentId}`, type: "archive", reference: "p. 1", documentId,
    documentPage,
  });
  family.people[0].birth = "1880";
  family.people[0].birthDateClaim = { value: "1880", sources: [source(documents[0][1], 2)] };
  family.people[0].birthPlace = "Town A";
  family.people[0].birthPlaceClaim = { value: "Town A", sources: [source(documents[0][1], 4)] };
  family.people[0].sources = [source(documents[0][1], 9)];
  family.people[0].events = [
    { id: "birth-event", type: "other", gedcomTag: "BIRT", sources: [source(documents[0][1], 10)] },
    { id: "residence-event", type: "residence", title: "Town A", sources: [source(documents[0][1], 11)] },
    { id: "work-event", type: "work", title: "Farmer", sources: [source(documents[0][1], 12)] },
  ];
  family.people[1].death = "1950";
  family.people[1].deathDateClaim = { value: "1950", sources: [source(documents[0][1], 5)] };
  family.people[1].deathPlace = "Town B";
  family.people[1].deathPlaceClaim = { value: "Town B", sources: [source(documents[0][1], 6)] };
  family.people[2].death = "1950";
  family.people[2].deathPlace = "Elsewhere";
  family.people[2].deathPlaceClaim = { value: "Elsewhere", sources: [source(documents[2][1])] };
  family.people[2].events = [{ id: "private-event", type: "work", title: "Private" }];
  family.unions = [{ id: "union", participants: ["parent", "partner"],
    type: "marriage", sources: [source(documents[1][1], 2)],
    formation: { date: "1900", sources: [source(documents[1][1], 3)] },
    ongoing: { date: "1905", sources: [source(documents[1][1], 4)] },
    divorce: { date: "1910", sources: [source(documents[1][1], 5)] } },
  { id: "ended", participants: ["parent", "partner"], type: "partnership",
    formation: { date: "1890", sources: [source(documents[1][1], 8)] },
    ending: { date: "1895", sources: [source(documents[1][1], 7)] } }];
  family.links = [
    { id: "visible-evidence", from: "parent", to: "partner", type: "guardian",
      sources: [source(documents[1][1], 9)] },
    { id: "private-evidence", from: "parent", to: "child", type: "guardian",
      sources: [source(documents[2][1], 2)] },
  ];
  const archive = await openArchive(dbPath, family);
  const auth = { currentUser: () => ({ id: "admin", name: "Admin", role: "admin",
    approved: true, createdAt: "" }) } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const route = gedcomHttp(archive, auth, dbPath, "https://test.invalid");
  const server = createServer(async (req, res) => {
    void (await route.handle(req, res, new URL(req.url!, "https://test.invalid")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await mkdir(join(dir, "uploads"), { recursive: true });
    for (const [title, id] of documents) {
      const file = `${id}.pdf`;
      const bytes = Buffer.from(`%PDF-1.4\n${id}\n%%EOF`);
      await writeFile(join(dir, "uploads", file), bytes);
      await archive.db.prepare(
        "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(id, title, title, file, bytes.length, "admin", "2026-01-01T00:00:00Z");
    }
    await archive.db.prepare("UPDATE documents SET event_links=? WHERE id=?")
      .run(JSON.stringify([{ personId: "child", eventId: "private-event" }]), documents[0][1]);
    const exported = async (ids: string[], name: string) => {
      const response = await fetch(`${base}/api/gedcom/export-visible?format=gedzip7`, {
        method: "POST",
        headers: { Origin: "https://test.invalid", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ids: JSON.stringify(ids) }),
      });
      assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
      const path = join(dir, `${name}.gdz`);
      const stage = join(dir, `${name}-stage`);
      await writeFile(path, Buffer.from(await response.arrayBuffer()));
      await mkdir(stage);
      return prepareGenealogyImport(path, stage, name);
    };
    const withUnion = await exported(["parent", "partner"], "with-union");
    assert.deepEqual(withUnion.files.map((file) => file.title).sort(), ["claim", "union"]);
    assert.equal(withUnion.family.unions?.length, 2);
    assert.equal(withUnion.family.links?.length, 1);
    assert.deepEqual(withUnion.files.find((file) => file.title === "claim")?.document?.eventLinks || [],
      [], "metadata for an excluded person's event stays out of the visible package");
    assert.deepEqual(withUnion.family.people.find((person) => person.name === "parent")
      ?.birthDateClaim?.sources.map((citation) => [citation.documentId, citation.documentPage]),
    [[withUnion.files.find((file) => file.title === "claim")?.documentId, 2]]);
    const claimId = withUnion.files.find((file) => file.title === "claim")?.documentId;
    const unionId = withUnion.files.find((file) => file.title === "union")?.documentId;
    assert.deepEqual([
      withUnion.family.people.find((person) => person.name === "parent")?.birthPlaceClaim?.sources[0],
      withUnion.family.people.find((person) => person.name === "partner")?.deathDateClaim?.sources[0],
      withUnion.family.people.find((person) => person.name === "partner")?.deathPlaceClaim?.sources[0],
    ].map((citation) => [citation?.documentId, citation?.documentPage]),
    [[claimId, 4], [claimId, 5], [claimId, 6]]);
    const parent = withUnion.family.people.find((person) => person.name === "parent")!;
    assert.deepEqual([
      parent.sources[0],
      ...["birth-event", "residence-event", "work-event"].map((id) =>
        parent.events?.find((event) => event.id === id)?.sources?.[0]),
    ].map((citation) => [citation?.documentId, citation?.documentPage]),
    [[claimId, 9], [claimId, 10], [claimId, 11], [claimId, 12]]);
    assert.deepEqual([
      withUnion.family.unions?.[0].sources?.[0],
      withUnion.family.unions?.[0].formation?.sources?.[0],
      withUnion.family.unions?.[0].ongoing?.sources?.[0],
      withUnion.family.unions?.[0].divorce?.sources?.[0],
    ].map((citation) => [citation?.documentId, citation?.documentPage]),
    [[unionId, 2], [unionId, 3], [unionId, 4], [unionId, 5]]);
    const partnership = withUnion.family.unions?.find((union) => union.id === "ended");
    assert.deepEqual([
      partnership?.formation?.sources?.[0], partnership?.ending?.sources?.[0],
    ].map((citation) => [citation?.documentId, citation?.documentPage]),
    [[unionId, 8], [unionId, 7]]);
    assert.deepEqual(withUnion.family.links?.[0].sources?.map((citation) =>
      [citation.documentId, citation.documentPage]), [[unionId, 9]]);
    assert.notEqual(withUnion.family.unions?.[0].formation?.sources?.[0].documentId,
      documents[1][1], "archive-local IDs are replaced on import");
    const plainText = exportGedcom(family, { version: "7.0",
      media: await exportMedia(archive.db, family) });
    assert.equal(importGedcom(plainText, "retained-citations").citationMedia?.length, 17,
      "repeated GEDCOM parsing must not retain links to discarded citation objects");
    const mismatched = plainText.replace(/^1 _DREVO (.+)$/m, (_line, json: string) => {
      const extra = JSON.parse(json);
      extra.sources[0].documentId = documents[2][1];
      const work = extra.events.find((event: { id: string }) => event.id === "work-event");
      work.sources[0].title = "Another record";
      work.sources[0].documentId = documents[2][1];
      return `1 _DREVO ${JSON.stringify(extra)}`;
    });
    const mismatch = importGedcom(mismatched, "mismatched-event");
    assert.equal(mismatch.family.people[0].sources[0].documentId, undefined);
    assert.equal(mismatch.family.people[0].events?.find((event) =>
      event.id === "work-event")?.sources?.[0].documentId, undefined,
    "neither a stale archive ID nor an unrelated GEDCOM citation can attach");
    assert.ok(mismatch.warnings.some((warning) => warning.includes("не сопоставлена с цитатой")));
    assert.throws(() => exportGedcom(family, { version: "7.0", media: [] }),
      /Документ цитаты отсутствует/);
    assert.match(plainText, /\d SOUR @S\d+@\r\n\d PAGE p\. 1\r\n\d _DREVO_CLAIM BIRTH_DATE\r\n\d OBJE @M\d+@/);
    const plainPath = join(dir, "citations.ged");
    const plainStage = join(dir, "plain-stage");
    await writeFile(plainPath, plainText);
    await mkdir(plainStage);
    const plain = await prepareGenealogyImport(plainPath, plainStage, "plain");
    assert.deepEqual(plain.files, []);
    assert.equal(plain.family.people.find((person) => person.name === "parent")
      ?.birthDateClaim?.sources[0].documentId, undefined);
    assert.equal(plain.family.people.find((person) => person.name === "parent")
      ?.sources[0].documentId, undefined);
    assert.equal(plain.family.people.find((person) => person.name === "parent")
      ?.events?.find((event) => event.id === "work-event")?.sources?.[0].documentId,
    undefined);
    assert.equal(plain.family.unions?.[0].formation?.sources?.[0].documentId, undefined);
    assert.equal(plain.family.links?.[0].sources?.[0].documentId, undefined);
    assert.ok(plain.warnings.some((warning) => warning.includes("Вложение цитаты не загружено")));
    const generalOnly = seed();
    generalOnly.people[0].sources = [source(documents[0][1], 9)];
    generalOnly.people[0].events = [{ id: "work-event", type: "work", title: "Farmer",
      sources: [source(documents[0][1], 12)] }];
    const generalText = exportGedcom(generalOnly, { version: "7.0",
      media: await exportMedia(archive.db, generalOnly) });
    const generalPath = join(dir, "general.ged");
    const generalStage = join(dir, "general-stage");
    await writeFile(generalPath, generalText);
    await mkdir(generalStage);
    const generalPlain = await prepareGenealogyImport(generalPath, generalStage, "general-only");
    assert.equal(generalPlain.family.people[0].sources[0].documentId, undefined);
    assert.equal(generalPlain.family.people[0].events?.[0].sources?.[0].documentId, undefined);
    assert.ok(generalPlain.warnings.some((warning) => warning.includes("Вложение цитаты не загружено")));
    const brokenPath = join(dir, "broken.gdz");
    const brokenStage = join(dir, "broken-stage");
    await zipFile(brokenPath, [["gedcom.ged", Buffer.from(generalText)]]);
    await mkdir(brokenStage);
    await assert.rejects(prepareGenealogyImport(brokenPath, brokenStage, "broken"),
      /отсутствует вложение/);
    const withoutUnion = await exported(["parent"], "without-union");
    assert.deepEqual(withoutUnion.files.map((file) => file.title), ["claim"]);
    assert.equal(withoutUnion.family.unions?.length || 0, 0);
    const targetDir = join(dir, "target");
    await mkdir(targetDir);
    const targetDb = join(targetDir, "archive.sqlite");
    const targetArchive = await openArchive(targetDb, seed());
    const targetRoute = gedcomHttp(targetArchive, auth, targetDb, "https://test.invalid");
    const targetServer = createServer(async (req, res) => {
      void (await targetRoute.handle(req, res, new URL(req.url!, "https://test.invalid")));
    });
    await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
    const targetBase = `http://127.0.0.1:${(targetServer.address() as { port: number }).port}`;
    try {
      const previewResponse = await fetch(`${targetBase}/api/gedcom/preview`, {
        method: "POST", headers: { Origin: "https://test.invalid", "X-Drevo-Import": "1" },
        body: new Uint8Array(await readFile(join(dir, "with-union.gdz"))),
      });
      assert.equal(previewResponse.status, 200,
        previewResponse.status === 200 ? "" : await previewResponse.text());
      const preview = await previewResponse.json();
      const applied = await fetch(`${targetBase}/api/gedcom/import`, {
        method: "POST", headers: { Origin: "https://test.invalid", "X-Drevo-Import": "1",
          "Content-Type": "application/json" },
        body: JSON.stringify({ token: preview.token, confirm: true }),
      });
      assert.equal(applied.status, 200, applied.status === 200 ? "" : await applied.text());
      const imported = (await targetArchive.read()).family.people.find((person) =>
        person.name === "parent" && person.id !== "parent")!;
      const importedId = imported.birthDateClaim?.sources[0].documentId;
      assert.ok(importedId && importedId !== documents[0][1]);
      assert.equal(imported.birthDateClaim?.sources[0].documentPage, 2);
      assert.deepEqual([
        imported.sources[0],
        ...["birth-event", "residence-event", "work-event"].map((id) =>
          imported.events?.find((event) => event.id === id)?.sources?.[0]),
      ].map((citation) => [citation?.documentId, citation?.documentPage]),
      [[importedId, 9], [importedId, 10], [importedId, 11], [importedId, 12]]);
      const row = await targetArchive.db.prepare("SELECT file_name FROM documents WHERE id=?")
        .get(importedId);
      assert.ok(row?.file_name);
      assert.match((await readFile(join(targetDir, "uploads", String(row.file_name)))).toString(),
        /%PDF-1\.4/);
      assert.equal((await targetArchive.read()).family.unions?.find((union) => union.id === "union")
        ?.formation?.sources?.[0].documentPage, 3);
    } finally {
      targetRoute.close();
      targetServer.closeAllConnections();
      await new Promise<void>((resolve) => targetServer.close(() => resolve()));
      await targetArchive.close();
    }
  } finally {
    route.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await archive.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy GEDCOM union JSON cannot carry an archive-local document ID into another tree", () => {
  const oldDocumentId = "44444444-4444-4444-8444-444444444444";
  const union = { id: "old", participants: ["one", "two"], type: "marriage",
    sources: [{ title: "Old record", type: "archive", reference: "", documentId: oldDocumentId,
      documentPage: 8 }] };
  const text = [
    "0 HEAD", "1 SOUR DREVO", "1 GEDC", "2 VERS 7.0",
    "0 @I1@ INDI", "1 NAME One /Test/", "0 @I2@ INDI", "1 NAME Two /Test/",
    "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
    `1 _DREVO_UNION ${JSON.stringify(union)}`, "1 _DREVO_SPOUSE Y", "0 TRLR",
  ].join("\n");
  const parsed = importGedcom(text, "legacy-union");
  assert.equal(parsed.family.unions?.[0].sources?.[0].documentId, undefined);
  assert.equal(parsed.family.unions?.[0].sources?.[0].documentPage, undefined);
  const dangling = text.replace("1 _DREVO_SPOUSE Y",
    "1 SOUR @S1@\n2 OBJE @M1@\n1 _DREVO_SPOUSE Y")
    .replace("0 TRLR", "0 @S1@ SOUR\n1 TITL Old record\n0 TRLR");
  assert.throws(() => importGedcom(dangling, "broken-union"), /Не найдено медиа цитаты/);
});

test("standard GEDCOM 7 citation OBJE imports an image as a cited document", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-standard-citation-"));
  try {
    const scan = await sharp({ create: { width: 2, height: 2, channels: 3,
      background: "white" } }).png().toBuffer();
    const ged = [
      "0 HEAD", "1 GEDC", "2 VERS 7.0", "0 @I1@ INDI",
      "1 NAME Anna /Sample/", "1 BIRT", "2 DATE 1 JAN 1900",
      "2 SOUR @S1@", "3 PAGE p. 2", "3 OBJE @M1@",
      "1 RESI", "2 TYPE Town", "2 SOUR @S1@", "3 PAGE p. 3", "3 OBJE @M1@",
      "1 SOUR @S1@", "2 PAGE p. 4", "2 OBJE @M1@",
      "1 OBJE @M1@",
      "0 @S1@ SOUR", "1 TITL Parish register",
      "0 @M1@ OBJE", "1 FILE media/scan.png", "2 FORM image/png",
      "2 TITL Scan", "0 TRLR",
    ].join("\n");
    const path = join(dir, "standard.gdz");
    const stage = join(dir, "stage");
    await zipFile(path, [["gedcom.ged", Buffer.from(ged)], ["media/scan.png", scan]]);
    await mkdir(stage);
    const imported = await prepareGenealogyImport(path, stage, "standard");
    assert.equal(imported.files.length, 1);
    assert.ok(imported.files[0].documentId);
    assert.equal(imported.family.photos?.length, 0);
    assert.equal(imported.family.people[0].sources[0].documentId,
      imported.files[0].documentId);
    assert.equal(imported.family.people[0].sources[0].reference, "p. 4");
    assert.equal(imported.family.people[0].sources[1].reference, "p. 2");
    assert.equal(imported.family.people[0].events?.find((event) => event.gedcomTag === "RESI")
      ?.sources?.[0].documentId, imported.files[0].documentId);
    assert.ok(imported.warnings.some((warning) => warning.includes("как фото и как документ")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    approved: true,
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
    const documentDetails = {
      documentType: "Метрическая запись",
      documentDate: "1887 год",
      place: "Мурзинка",
      description: "Лист 7",
      provenance: "ГАСО, Ф. 6",
      pages: [{ number: 7, description: "Запись о семье" }],
    };
    const ged = external7
      .replace(
        "0 TRLR",
        `0 @D@ OBJE\n1 FILE media/document.pdf\n2 FORM application/pdf\n2 TITL Документ\n1 _DREVO_MEDIA ${JSON.stringify({ document: documentDetails })}\n0 TRLR`,
      )
      .replace("1 OBJE @M@", "1 OBJE @M@\n1 OBJE @D@");
    await zipFile(path, [
      ["gedcom.ged", Buffer.from(ged)],
      ["media/photo.png", image],
      ["media/document.pdf", Buffer.from("%PDF-1.4\n%%EOF")],
    ]);
    const expiredExport = join(dir, "staging", "genealogy", "export-ABC123");
    await mkdir(expiredExport);
    await writeFile(join(expiredExport, "export.gdz"), "abandoned");
    const expiredAt = new Date(Date.now() - 25 * 60 * 60_000);
    await utimes(expiredExport, expiredAt, expiredAt);
    const response = await request("/api/gedcom/preview", await readFile(path));
    assert.equal(response.status, 200);
    assert.ok(
      !(await readdir(join(dir, "staging", "genealogy"))).includes(
        "export-ABC123",
      ),
    );
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
    assert.equal(
      Number(
        (await archive.db.prepare("SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM document_upload_requests").get())?.bytes,
      ),
      0,
      "failed GEDZIP installation releases its disk reservation",
    );
    assert.equal(
      (await archive.db
        .prepare("SELECT count(*) AS n FROM media_originals")
        .get())!.n,
      0,
    );
    await archive.db.exec("DROP TRIGGER reject_document");
    const beforeImportIds = new Set((await archive.read()).family.people.map((person) => person.id));
    const applied = await request("/api/gedcom/import", {
      token: preview.token,
      confirm: true,
    });
    assert.equal(applied.status, 200, await applied.text());
    assert.equal(
      Number(
        (await archive.db.prepare("SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM document_upload_requests").get())?.bytes,
      ),
      0,
      "successful GEDZIP installation releases its disk reservation",
    );
    assert.equal((await archive.read()).family.people.length, 5);
    const importedIds = (await archive.read()).family.people
      .filter((person) => !beforeImportIds.has(person.id)).map((person) => person.id);
    assert.equal(importedIds.length, 2);
    const importedPublications = await archive.db.prepare(
      `SELECT person_id FROM published_people WHERE person_id IN (${importedIds.map(() => "?").join(",")})`,
    ).all(...importedIds);
    assert.deepEqual(importedPublications, [],
      "GEDCOM import leaves every new card hidden from cross-archive search until explicit publication");
    const original = await archive.db
      .prepare("SELECT url,size_bytes,uploaded_by FROM media_originals")
      .get();
    assert.match(String(original?.url), /^\/media\/[\w-]+\.png$/);
    assert.equal(original?.size_bytes, image.length);
    assert.equal(original?.uploaded_by, "admin");
    assert.equal(
      (await archive.db.prepare("SELECT count(*) AS n FROM documents").get())!
        .n,
      1,
    );
    const importedDocument = await archive.db
      .prepare(
        "SELECT title_search,document_type,document_date,place,description,provenance,pages FROM documents",
      )
      .get();
    assert.equal(importedDocument?.document_type, documentDetails.documentType);
    assert.equal(importedDocument?.document_date, documentDetails.documentDate);
    assert.equal(importedDocument?.place, documentDetails.place);
    assert.equal(importedDocument?.description, documentDetails.description);
    assert.equal(importedDocument?.provenance, documentDetails.provenance);
    assert.deepEqual(JSON.parse(String(importedDocument?.pages)), documentDetails.pages);
    assert.match(String(importedDocument?.title_search), /мурзинка/);
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
    const exportedBytes = Buffer.from(await exported.arrayBuffer());
    assert.ok(exportedBytes.length > 0);
    let temporaryExports: string[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      temporaryExports = (
        await readdir(join(dir, "staging", "genealogy"))
      ).filter((name) => name.startsWith("export-"));
      if (!temporaryExports.length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(temporaryExports, []);
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
    for (const format of ["gedcom7", "gedzip7"] as const) {
      const visible = await fetch(`${base}/api/gedcom/export-visible?format=${format}`, {
        method: "POST",
        headers: {
          Origin: "https://test.invalid",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ ids: JSON.stringify(["child"]) }),
      });
      assert.equal(visible.status, 200);
      if (format === "gedcom7") {
        const imported = importGedcom(await visible.text(), "visible-export");
        assert.deepEqual(imported.family.people.map((person) => person.name), ["child"]);
        assert.deepEqual(imported.family.people[0].parents, []);
      } else {
        const visiblePath = join(dir, "visible.gdz");
        const visibleStage = join(dir, "visible-stage");
        await writeFile(visiblePath, Buffer.from(await visible.arrayBuffer()));
        await mkdir(visibleStage);
        const imported = await prepareGenealogyImport(visiblePath, visibleStage, "visible");
        assert.deepEqual(imported.family.people.map((person) => person.name), ["child"]);
      }
    }
    assert.equal((await fetch(`${base}/api/gedcom/export-visible?format=gedcom7`, {
      method: "POST",
      headers: { Origin: "https://test.invalid", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ids: JSON.stringify(["missing"]) }),
    })).status, 400);
    assert.equal(
      (await request("/api/gedcom/export?format=agelongXml")).status,
      400,
    );
    assert.equal(
      (await request("/api/gedcom/export?format=agelongZip")).status,
      400,
    );
    const exportedPath = join(dir, "round.gdz");
    const exportedStage = join(dir, "round-stage");
    await writeFile(exportedPath, exportedBytes);
    await mkdir(exportedStage);
    const exportedImport = await prepareGenealogyImport(
      exportedPath,
      exportedStage,
      "round",
    );
    assert.deepEqual(
      exportedImport.files.find((file) => file.documentId)?.document,
      documentDetails,
    );
    const round = await request("/api/gedcom/preview", exportedBytes);
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
    actor = { ...actor!, approved: false };
    assert.equal((await request("/api/gedcom/export?format=gedcom7")).status, 403);
    actor = { ...actor, role: "relative", approved: true };
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
