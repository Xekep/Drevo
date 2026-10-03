import test from "node:test";
import assert from "node:assert/strict";
import { importGedcom, exportGedcom } from "../src/domain/gedcom.ts";

for (const version of ["5.5.1", "7.0"] as const) {
  test(`GEDCOM ${version} keeps recorded event age and warns when its structure is flattened`, () => {
    const input = [
      "0 HEAD",
      "1 SOUR TEST",
      "1 GEDC",
      `2 VERS ${version}`,
      ...(version === "5.5.1" ? ["2 FORM LINEAGE-LINKED", "1 CHAR UTF-8"] : []),
      "0 @I1@ INDI",
      "1 NAME Anna /Test/",
      "1 CENS",
      "2 DATE 1900",
      "2 AGE 35y",
      ...(version === "7.0" ? ["3 PHRASE about thirty-five"] : []),
      "2 NOTE Household roll",
      "1 DEAT Y",
      "2 AGE 72y",
      "0 TRLR",
    ].join("\r\n");

    const first = importGedcom(input, `age-${version}`);
    const person = first.family.people[0];
    const census = person.events?.find((event) => event.gedcomTag === "CENS");
    const death = person.events?.find((event) => event.gedcomTag === "DEAT");
    assert.equal(census?.date, "1900");
    assert.match(census?.description || "", /Household roll/);
    assert.match(census?.description || "", /35y/);
    if (version === "7.0")
      assert.match(census?.description || "", /about thirty-five/);
    assert.equal(death?.description?.includes("72y"), true);
    assert.equal(death?.date, undefined);
    assert.ok(first.warnings.some((warning) => /AGE/.test(warning) && /структур/i.test(warning)));

    const second = importGedcom(exportGedcom(first.family, { version }), `age-back-${version}`);
    const restored = second.family.people[0];
    const restoredCensus = restored.events?.find((event) => event.gedcomTag === "CENS");
    const restoredDeath = restored.events?.find((event) => event.gedcomTag === "DEAT");
    assert.equal(restoredCensus?.description, census?.description);
    assert.equal(restoredDeath?.description, death?.description);
    assert.equal((restoredCensus?.description?.match(/35y/g) || []).length, 1);
    assert.equal((restoredDeath?.description?.match(/72y/g) || []).length, 1);
  });
}
