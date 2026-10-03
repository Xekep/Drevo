import test from "node:test";
import assert from "node:assert/strict";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";

for (const version of ["5.5.1", "7.0"] as const) test(
  `GEDCOM ${version} retains the adoption event date and place alongside adoptive parents`,
  () => {
    const external = [
      "0 HEAD", "1 GEDC", `2 VERS ${version}`, "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Anna /Child/",
      "1 ADOP Y", "2 DATE 2 MAR 1910", "2 PLAC Tula", "2 NOTE Court decree",
      "2 FAMC @F1@", "3 ADOP BOTH",
      "1 FAMC @F1@", "2 PEDI adopted",
      "0 @I2@ INDI", "1 NAME Ivan /Parent/", "1 SEX M", "1 FAMS @F1@",
      "0 @I3@ INDI", "1 NAME Maria /Parent/", "1 SEX F", "1 FAMS @F1@",
      "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@",
      "0 TRLR", "",
    ].join("\n");
    const first = importGedcom(external, `adoption-${version}`);
    const child = first.family.people[0];
    const adoption = child.events?.find((event) => event.gedcomTag === "ADOP");
    assert.equal(adoption?.type, "other");
    assert.equal(adoption?.title, "Усыновление");
    assert.equal(adoption?.date, "1910-03-02");
    assert.equal(adoption?.place, "Tula");
    assert.equal(adoption?.description, "Court decree");
    assert.ok(first.warnings.some((warning) => warning.includes("ADOP.FAMC") &&
      warning.includes("сохранены отдельно")));
    assert.equal(child.parents.length, 0);
    assert.equal(first.family.links?.filter((link) =>
      link.type === "adoptive_parent" && link.to === child.id).length, 2);

    const second = importGedcom(exportGedcom(first.family, { version }), `again-${version}`);
    const restored = second.family.people[0];
    const restoredAdoption = restored.events?.find((event) => event.gedcomTag === "ADOP");
    assert.equal(restoredAdoption?.date, "1910-03-02");
    assert.equal(restoredAdoption?.place, "Tula");
    assert.equal(restoredAdoption?.description, "Court decree");
    assert.equal(restored.parents.length, 0);
    assert.equal(second.family.links?.filter((link) =>
      link.type === "adoptive_parent" && link.to === restored.id).length, 2);
  },
);
