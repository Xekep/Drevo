import test from "node:test";
import assert from "node:assert/strict";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { validateFamily } from "../src/domain/validation.ts";
import type { Source } from "../src/domain/types.ts";

test("an edited inline repository survives validation and GEDCOM 5.5.1/7 without changing PAGE or source URL", () => {
  const family = importGedcom(
    `0 HEAD
1 SOUR DREVO
1 GEDC
2 VERS 7.0
0 @I1@ INDI
1 NAME Anna /Test/
0 TRLR`,
    "repository-edit",
  ).family;
  const source: Source = {
    title: "Register",
    type: "archive",
    reference: "leaf 7",
    url: "https://source.example/register",
    note: "citation note",
    repository: {
      name: "State archive",
      callNumber: "F. 6 / D. 4",
      website: "https://repository.example",
      note: "appointment required",
      linkNote: "reading room",
    },
  };
  family.people[0].sources = [source];
  assert.doesNotThrow(() => validateFamily(family));
  for (const version of ["5.5.1", "7.0"] as const) {
    const text = exportGedcom(family, { version });
    const restored = importGedcom(text, `repository-${version}`).family
      .people[0].sources[0];
    assert.deepEqual(restored.repository, source.repository);
    assert.equal(restored.reference, "leaf 7");
    assert.equal(restored.url, "https://source.example/register");
    assert.equal(restored.note, "citation note");
  }

  const catalog = structuredClone(family);
  catalog.people[0].sources[0].catalogId = "catalog-1";
  assert.throws(() => validateFamily(catalog), /источник/i);

  const removed = structuredClone(family);
  delete removed.people[0].sources[0].repository;
  assert.doesNotThrow(() => validateFamily(removed));
  assert.doesNotMatch(
    exportGedcom(removed, { version: "7.0" }),
    /1 REPO @R\d+@/,
  );
  assert.equal(removed.people[0].sources[0].reference, "leaf 7");
});
