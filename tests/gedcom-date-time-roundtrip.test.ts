import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";

const input = [
  "0 HEAD", "1 SOUR TEST", "1 GEDC", "2 VERS 7.0",
  "0 @I1@ INDI", "1 NAME Alex /Example/", "1 SEX M",
  "1 BIRT", "2 DATE 1 JAN 1900", "3 TIME 12:34:56.7Z", "2 PLAC Birthville",
  "1 DEAT", "2 DATE 2 FEB 1980", "3 TIME 01:02", "2 PLAC Deathville",
  "1 RESI", "2 DATE 3 MAR 1920", "3 TIME 23:59:59", "2 PLAC Homeville",
  "0 @I2@ INDI", "1 NAME Sam /Example/", "1 SEX F",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
  "1 MARR", "2 DATE 4 APR 1930", "3 TIME 14:15", "2 PLAC Weddingville",
  "2 SOUR @S1@", "3 PAGE 4",
  "0 @S1@ SOUR", "1 TITL Marriage register", "0 TRLR",
].join("\n");

const timedEvent = (person: ReturnType<typeof importGedcom>["family"]["people"][number],
  tag: string) => person.events?.find((event) => event.gedcomTag === tag);

test("GEDCOM 7 DATE.TIME stays with its birth, death, personal and family events", () => {
  const first = importGedcom(input, "date-time");
  const [alex, sam] = first.family.people;
  for (const [tag, time] of [["BIRT", "12:34:56.7Z"], ["DEAT", "01:02"],
    ["RESI", "23:59:59"], ["MARR", "14:15"]]) {
    const event = timedEvent(alex, tag);
    assert.match(event?.description || "", new RegExp(time.replaceAll(".", "\\.")));
    assert.equal((event?.description?.match(/DATE\.TIME:/g) || []).length, 1);
  }
  assert.equal(alex.birth, "1900-01-01");
  assert.equal(alex.death, "1980-02-02");
  assert.equal(timedEvent(alex, "MARR")?.place, "Weddingville");
  assert.equal(timedEvent(alex, "MARR")?.sources?.[0]?.reference, "4");
  assert.match(timedEvent(sam, "MARR")?.description || "", /DATE\.TIME: 14:15/);
  assert.doesNotMatch(timedEvent(sam, "MARR")?.description || "", /12:34:56/);
  assert.ok(first.warnings.some((warning) => /DATE\.TIME/.test(warning)));

  for (const version of ["7.0", "5.5.1"] as const) {
    const output = exportGedcom(first.family, { version });
    const second = importGedcom(output, `date-time-${version}`);
    for (const personIndex of [0, 1])
      for (const tag of (personIndex ? ["MARR"] : ["BIRT", "DEAT", "RESI", "MARR"]))
        assert.equal(timedEvent(second.family.people[personIndex], tag)?.description,
          timedEvent(first.family.people[personIndex], tag)?.description);
  }
});

test("ambiguous DATE.TIME is preserved as raw text and warned without inventing a timestamp", () => {
  const modified = input.replace("2 DATE 3 MAR 1920\n3 TIME 23:59:59",
    "2 DATE FROM 1920 TO 1930\n3 TIME 25:61");
  const result = importGedcom(modified, "ambiguous-time");
  const event = timedEvent(result.family.people[0], "RESI");
  assert.equal(event?.date, "1920");
  assert.equal(event?.endDate, "1930");
  assert.match(event?.description || "", /DATE\.TIME: 25:61/);
  assert.ok(result.warnings.some((warning) => /DATE\.TIME/.test(warning) && /неоднознач|недопуст/.test(warning)));
  assert.equal(timedEvent(importGedcom(exportGedcom(result.family, { version: "7.0" }),
    "ambiguous-time-again").family.people[0], "RESI")?.description, event?.description);
});

test("Drevo metadata matches only the same event context and does not duplicate DATE.TIME", () => {
  const original = importGedcom(input, "original-time");
  const exported = exportGedcom(original.family, { version: "7.0" });
  const same = exported.replace("1 BIRT\r\n2 TYPE Рождение\r\n2 DATE 1 JAN 1900",
    "1 BIRT\r\n2 TYPE Рождение\r\n2 DATE 1 JAN 1900\r\n3 TIME 12:34:56.7Z")
    .replace("1 MARR Y\r\n2 DATE 4 APR 1930",
      "1 MARR Y\r\n2 DATE 4 APR 1930\r\n3 TIME 14:15");
  assert.notEqual(same, exported);
  const duplicate = importGedcom(same, "same-time");
  const person = duplicate.family.people[0];
  assert.equal((timedEvent(person, "BIRT")?.description?.match(/12:34:56\.7Z/g) || []).length, 1);
  assert.equal((timedEvent(person, "MARR")?.description?.match(/14:15/g) || []).length, 1);
  assert.doesNotMatch(person.biography || "", /DATE\.TIME/);

  const changed = same.replace("2 DATE 1 JAN 1900\r\n3 TIME 12:34:56.7Z",
    "2 DATE ABT 1910\r\n3 TIME 12:34:56.7Z")
    .replace("1 MARR Y\r\n2 DATE 4 APR 1930\r\n3 TIME 14:15",
      "1 MARR Y\r\n2 DATE FROM 1930 TO 1931\r\n3 TIME 14:15");
  const result = importGedcom(changed, "changed-time");
  assert.equal(timedEvent(result.family.people[0], "BIRT")?.date, "1900-01-01");
  for (const personWithMarriage of result.family.people) {
    assert.match(personWithMarriage.biography || "", /FROM 1930 TO 1931/);
    assert.match(personWithMarriage.biography || "", /DATE\.TIME: 14:15/);
  }
  assert.match(result.family.people[0].biography || "", /ABT 1910/);
  assert.match(result.family.people[0].biography || "", /DATE\.TIME: 12:34:56\.7Z/);
  assert.ok(result.warnings.some((warning) => /DATE\.TIME.*биограф/.test(warning)));
  const again = importGedcom(exportGedcom(result.family, { version: "7.0" }), "changed-time-again");
  for (let index = 0; index < result.family.people.length; index++)
    assert.equal(again.family.people[index].biography, result.family.people[index].biography);
});

test("GEDCOM 7 DATE_VALUE kinds retain TIME without false invalidity warnings", () => {
  for (const [name, date] of [
    ["approximate", "ABT 3 MAR 1920"],
    ["range", "BET 3 MAR 1920 AND 4 MAR 1920"],
    ["calendar", "JULIAN 3 MAR 1920"],
    ["empty", ""],
    ["year", "1920"],
  ]) {
    const modified = input.replace("2 DATE 3 MAR 1920\n3 TIME 23:59:59",
      `2 DATE${date ? ` ${date}` : ""}\n3 TIME 23:59:59`);
    const imported = importGedcom(modified, `time-${name}`);
    const residence = timedEvent(imported.family.people[0], "RESI");
    assert.match(residence?.description || "",
      /DATE\.TIME: 23:59:59/, name);
    assert.equal(imported.warnings.some((warning) => /Недопустимый.*DATE\.TIME/.test(warning)),
      false, name);
    if (name === "calendar") {
      assert.equal(residence?.date, undefined, "JULIAN date is not converted to Gregorian");
      assert.equal(residence?.dateText, date, "the source calendar and day remain together");
      const again = importGedcom(exportGedcom(imported.family, { version: "7.0" }),
        "julian-time-again");
      assert.equal(timedEvent(again.family.people[0], "RESI")?.dateText, date);
      assert.equal(timedEvent(again.family.people[0], "RESI")?.description,
        residence?.description);
    }
  }
  const historic = input.replace("2 VERS 7.0", "2 VERS 5.5.1");
  const historicImport = importGedcom(historic, "nonstandard-time");
  assert.ok(historicImport.warnings.some((warning) => /DATE\.TIME.*5\.5\.1/.test(warning)));
});

test("DatePeriod, malformed TIME and repeated TIME retain raw text with explicit warnings", () => {
  for (const [name, dateAndTime] of [
    ["period", "2 DATE FROM 1920 TO 1930\n3 TIME 23:59:59"],
    ["open-period", "2 DATE TO 1930\n3 TIME 23:59:59"],
    ["malformed", "2 DATE 3 MAR 1920\n3 TIME 25:61"],
    ["repeated", "2 DATE 3 MAR 1920\n3 TIME 23:59:59\n3 TIME 01:02"],
  ]) {
    const modified = input.replace("2 DATE 3 MAR 1920\n3 TIME 23:59:59", dateAndTime);
    const imported = importGedcom(modified, `invalid-time-${name}`);
    assert.match(timedEvent(imported.family.people[0], "RESI")?.description || "",
      /DATE\.TIME:/, name);
    assert.ok(imported.warnings.some((warning) => /Недопустимый.*DATE\.TIME/.test(warning)), name);
    if (name === "repeated")
      assert.match(timedEvent(imported.family.people[0], "RESI")?.description || "",
        /DATE\.TIME: 01:02/);
  }
});

test("other family events retain DATE.TIME and metadata without events uses a contextual fallback", () => {
  const source = input.replace("1 MARR\n2 DATE 4 APR 1930", "1 MARR\n2 DATE 4 APR 1930")
    .replace("2 SOUR @S1@\n3 PAGE 4", [
      "2 SOUR @S1@", "3 PAGE 4",
      "1 ENGA", "2 DATE 5 MAY 1929", "3 TIME 09:10",
      "1 DIV", "2 DATE 6 JUN 1940", "3 TIME 11:12",
    ].join("\n"))
    .replace("1 NAME Sam /Example/", '1 NAME Sam /Example/\n1 _DREVO {"biography":"Existing note"}');
  const parsed = importGedcom(source, "other-family-time");
  for (const person of parsed.family.people.slice(0, 1)) {
    assert.match(timedEvent(person, "ENGA")?.description || "", /DATE\.TIME: 09:10/);
    assert.match(timedEvent(person, "DIV")?.description || "", /DATE\.TIME: 11:12/);
  }
  assert.match(parsed.family.people[1].biography || "", /Existing note/);
  assert.match(parsed.family.people[1].biography || "", /ENGA:[\s\S]*DATE\.TIME: 09:10/);
  assert.match(parsed.family.people[1].biography || "", /DIV:[\s\S]*DATE\.TIME: 11:12/);
  assert.ok(parsed.warnings.some((warning) => /DATE\.TIME.*биограф/.test(warning)));
});

test("GEDZIP import previews and retains event DATE.TIME", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-gedcom-time-"));
  try {
    const zipPath = join(directory, "input.gdz"), stage = join(directory, "stage"),
      uploads = join(directory, "uploads");
    await mkdir(stage);
    await mkdir(uploads);
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from(input), "gedcom.ged");
    await new Promise<void>((resolve, reject) => {
      zip.outputStream.pipe(createWriteStream(zipPath))
        .once("finish", resolve).once("error", reject);
      zip.end();
    });
    const parsed = await prepareGenealogyImport(zipPath, stage, "zipped-time");
    assert.match(timedEvent(parsed.family.people[0], "BIRT")?.description || "",
      /DATE\.TIME: 12:34:56\.7Z/);
    assert.ok(parsed.warnings.some((warning) => /DATE\.TIME/.test(warning)));
    const portablePath = join(directory, "time.drevo");
    await writePortablePackage(createWriteStream(portablePath), uploads, {
      family: parsed.family, documents: [], comments: [], sources: [],
    }, async () => {});
    const portable = await readPortablePackage(portablePath, stage);
    assert.equal(timedEvent(portable.snapshot.family.people[0], "BIRT")?.description,
      timedEvent(parsed.family.people[0], "BIRT")?.description);
    assert.match(timedEvent(portable.snapshot.family.people[1], "MARR")?.description || "",
      /DATE\.TIME: 14:15/);
    const outbound = join(directory, "outbound.gdz");
    await writeGenealogyPackage(outbound, uploads, portable.snapshot.family, []);
    const again = await prepareGenealogyImport(outbound, stage, "zipped-time-again");
    for (let index = 0; index < parsed.family.people.length; index++)
      for (const tag of (index ? ["MARR"] : ["BIRT", "DEAT", "RESI", "MARR"]))
        assert.equal(timedEvent(again.family.people[index], tag)?.description,
          timedEvent(parsed.family.people[index], tag)?.description);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
