import test from "node:test";
import assert from "node:assert/strict";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";

test("GEDCOM 7 preserves each citation's OBJE.TITL without changing the shared FILE.TITL", () => {
  const input = `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS 7.0
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Test/
1 SOUR @S1@
2 PAGE leaf 3
2 OBJE @M1@
3 TITL Anna's annotated entry
0 @I2@ INDI
1 NAME Boris /Test/
1 SOUR @S1@
2 PAGE leaf 9
2 OBJE @M1@
3 TITL Boris's unannotated entry
0 @S1@ SOUR
1 TITL Parish register
0 @M1@ OBJE
1 FILE scan.png
2 FORM image/png
2 TITL Whole volume scan
0 TRLR`;
  const imported = importGedcom(input, "citation-link-title");
  assert.equal(imported.media.length, 1);
  assert.equal(imported.media[0].title, "Whole volume scan");
  assert.equal(imported.citationMedia?.length, 2);
  assert.equal(imported.citationMedia?.[0].mediaId, imported.citationMedia?.[1].mediaId);
  const [anna, boris] = imported.family.people.map((person) => person.sources[0]);
  assert.ok(anna.note?.includes("Anna's annotated entry"));
  assert.ok(boris.note?.includes("Boris's unannotated entry"));
  assert.ok(!anna.note?.includes("Boris's unannotated entry"));
  assert.ok(!boris.note?.includes("Anna's annotated entry"));
  assert.ok(imported.warnings.some((warning) => warning.includes("SOUR.OBJE.TITL")));

  const roundtrip = importGedcom(exportGedcom(imported.family, { version: "7.0" }),
    "citation-link-title-again");
  assert.deepEqual(roundtrip.family.people.map((person) => person.sources[0].note),
    [anna.note, boris.note]);
});

test("a citation's own OBJE.TITL takes priority over its source record's link title", () => {
  const input = `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS 7.0
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Test/
1 SOUR @S1@
0 @I2@ INDI
1 NAME Boris /Test/
1 SOUR @S1@
2 OBJE @M2@
3 TITL Boris's entry
0 @S1@ SOUR
1 TITL Parish register
1 OBJE @M1@
2 TITL Complete register
0 @M1@ OBJE
1 FILE whole.png
2 FORM image/png
2 TITL Original volume
0 @M2@ OBJE
1 FILE page.png
2 FORM image/png
2 TITL Original page
0 TRLR`;
  const imported = importGedcom(input, "source-link-title");
  const [anna, boris] = imported.family.people.map((person) => person.sources[0]);
  assert.ok(anna.note?.includes("SOURCE_RECORD.OBJE.TITL") &&
    anna.note.includes("Complete register"));
  assert.ok(boris.note?.includes("SOUR.OBJE.TITL") && boris.note.includes("Boris's entry"));
  assert.ok(!boris.note?.includes("Complete register"));
  assert.deepEqual(imported.media.map((item) => item.title),
    ["Original volume", "Original page"]);
  assert.equal(imported.citationMedia?.length, 2);
  assert.notEqual(imported.citationMedia?.[0].mediaId, imported.citationMedia?.[1].mediaId);
  assert.ok(imported.warnings.some((warning) =>
    warning.includes("SOURCE_RECORD.OBJE.TITL") && warning.includes("текстом")));
  assert.ok(imported.warnings.some((warning) =>
    warning.includes("SOUR.OBJE.TITL") && warning.includes("текстом")));
});
