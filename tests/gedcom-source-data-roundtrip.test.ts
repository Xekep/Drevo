import test from "node:test";
import assert from "node:assert/strict";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} retains cited SOURCE_RECORD.DATA provenance through round-trip`, () => {
    const input = `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS ${version}
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Test/
1 SOUR @S1@
2 PAGE leaf 3
1 SOUR @S2@
2 PAGE leaf 9
0 @S1@ SOUR
1 TITL Parish register
1 NOTE Bound volume
1 DATA
2 EVEN BIRT
3 DATE FROM 1890 TO 1910
${version === "7.0" ? "4 PHRASE about the turn of the century\n" : ""}3 PLAC Tver
2 AGNC Parish registrar
2 NOTE First register preserves annotations
0 @S2@ SOUR
1 TITL District census
1 DATA
2 EVEN CENS
3 DATE 1900
2 AGNC District office
2 NOTE Second register is incomplete
0 TRLR`;
    const imported = importGedcom(input, `source-data-${version}`);
    const [first, second] = imported.family.people[0].sources;
    assert.equal(first.reference, "leaf 3");
    assert.equal(second.reference, "leaf 9");
    for (const detail of ["Bound volume", "Parish registrar", "BIRT", "FROM 1890 TO 1910",
      "Tver", "First register preserves annotations"])
      assert.ok(first.note?.includes(detail), `${detail} missing from first citation note`);
    if (version === "7.0")
      assert.ok(first.note?.includes("about the turn of the century"));
    for (const detail of ["District office", "CENS", "1900",
      "Second register is incomplete"])
      assert.ok(second.note?.includes(detail), `${detail} missing from second citation note`);
    assert.ok(!first.note?.includes("District office"));
    assert.ok(!second.note?.includes("Parish registrar"));
    assert.ok(imported.warnings.some((warning) => warning.includes("SOURCE_RECORD.DATA")));

    const exported = exportGedcom(imported.family, { version });
    assert.doesNotMatch(exported, /^1 DATA(?:\r?\n|$)/m);
    const roundtrip = importGedcom(exported,
      `source-data-again-${version}`);
    assert.deepEqual(roundtrip.family.people[0].sources.map((source) => source.note),
      [first.note, second.note]);
  });
