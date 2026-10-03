import test from "node:test";
import assert from "node:assert/strict";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";

test("GEDCOM 7 void source citation retains its text through import and export", () => {
  const input = `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS 7.0
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Test/
1 SOUR @VOID@
2 PAGE Her granddaughter Lydia told me this in 1980
2 NOTE Personal interview, no source record
1 SOUR @S1@
2 PAGE leaf 7
0 @S1@ SOUR
1 TITL Parish register
0 TRLR`;
  const imported = importGedcom(input, "void-source");
  const [voidCitation, recordedCitation] = imported.family.people[0].sources;
  assert.equal(voidCitation.title, "Her granddaughter Lydia told me this in 1980");
  assert.equal(voidCitation.reference, "");
  assert.equal(voidCitation.note, "Personal interview, no source record");
  assert.equal(recordedCitation.title, "Parish register");
  assert.equal(recordedCitation.reference, "leaf 7");
  assert.ok(imported.warnings.some((warning) =>
    warning.includes("SOUR @VOID@") && warning.includes("PAGE сохранён") &&
    warning.includes("исходный @VOID@ не восстанавливается")));

  const roundtrip = importGedcom(exportGedcom(imported.family, { version: "7.0" }),
    "void-source-again");
  assert.deepEqual(roundtrip.family.people[0].sources.map((source) => ({
    title: source.title, reference: source.reference, note: source.note,
  })), imported.family.people[0].sources.map((source) => ({
    title: source.title, reference: source.reference, note: source.note,
  })));
});

test("GEDCOM 7 void place citation without PAGE has an explicit unknown-source label", () => {
  const input = `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS 7.0
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Test/
1 BIRT
2 PLAC Tver
3 SOUR @VOID@
4 NOTE Oral account, source unknown
0 TRLR`;
  const imported = importGedcom(input, "void-without-page");
  const source = imported.family.people[0].birthPlaceClaim?.sources[0];
  assert.ok(source);
  assert.equal(source.title, "Источник не указан");
  assert.equal(source.reference, "");
  assert.equal(source.note, "Oral account, source unknown");
  assert.ok(imported.warnings.some((warning) =>
    warning.includes("SOUR @VOID@ без PAGE") &&
    warning.includes("Источник не указан") &&
    warning.includes("обычной записью SOUR") &&
    warning.includes("исходный @VOID@ не восстанавливается")));
  const roundtrip = importGedcom(exportGedcom(imported.family, { version: "7.0" }),
    "void-without-page-again");
  assert.deepEqual(roundtrip.family.people[0].birthPlaceClaim?.sources[0], source);
});

test("only the GEDCOM 7 void pointer bypasses a missing source-record error", () => {
  const input = `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS 7.0
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Test/
1 SOUR @VOID@
2 PAGE Interview, 1980
0 TRLR`;
  assert.throws(() => importGedcom(input.replace("@VOID@", "@MISSING@"),
    "unknown-source"), /Не найден источник @MISSING@/);
  assert.throws(() => importGedcom(input.replace("2 VERS 7.0", "2 VERS 5.5.1"),
    "old-void-source"), /Не найден источник @VOID@/);
});
