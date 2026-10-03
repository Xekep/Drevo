import test from "node:test";
import assert from "node:assert/strict";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";

for (const version of ["5.5.1", "7.0"] as const) {
  test(`GEDCOM ${version} preserves a source abbreviation alongside its title`, () => {
    const input = `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS ${version}
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Test/
1 SOUR @S1@
2 PAGE leaf 3
0 @I2@ INDI
1 NAME Boris /Test/
1 SOUR @S1@
2 PAGE leaf 9
0 @S1@ SOUR
1 TITL Parish register of St. Mary
1 ABBR St. Mary PR
0 TRLR`;
    const imported = importGedcom(input, `source-abbr-${version}`);
    const citations = imported.family.people.map((person) => person.sources[0]);
    assert.deepEqual(citations.map((source) => source.title),
      ["Parish register of St. Mary", "Parish register of St. Mary"]);
    assert.deepEqual(citations.map((source) => source.reference), ["leaf 3", "leaf 9"]);
    for (const source of citations)
      assert.ok(source.note?.includes("St. Mary PR"));
    assert.equal(imported.warnings.filter((warning) =>
      warning.includes("SOURCE_RECORD.ABBR") && warning.includes("текстом")).length, 1);

    const roundtrip = importGedcom(exportGedcom(imported.family, { version }),
      `source-abbr-${version}-again`);
    assert.deepEqual(roundtrip.family.people.map((person) => person.sources[0].note),
      citations.map((source) => source.note));
  });

  test(`GEDCOM ${version} keeps ABBR-only titles and avoids duplicate notes`, () => {
    const input = `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS ${version}
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Test/
1 SOUR @S1@
1 SOUR @S2@
1 SOUR @S3@
0 @S1@ SOUR
1 ABBR Only abbreviation
0 @S2@ SOUR
1 TITL Same text
1 ABBR Same text
0 @S3@ SOUR
1 TITL Full title
1 ABBR
0 TRLR`;
    const imported = importGedcom(input, `source-abbr-controls-${version}`);
    assert.deepEqual(imported.family.people[0].sources.map((source) => source.title),
      ["Only abbreviation", "Same text", "Full title"]);
    assert.ok(imported.family.people[0].sources.every((source) => !source.note));
    assert.ok(!imported.warnings.some((warning) => warning.includes("SOURCE_RECORD.ABBR")));
  });
}
