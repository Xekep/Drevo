import test from "node:test";
import assert from "node:assert/strict";
import { requestedArchiveExport } from "../src/domain/research-export.ts";

test("archive export offers explicit formats without sending archive content to the model", () => {
  const options = requestedArchiveExport("Сделай экспорт", "person-1");
  assert.deepEqual(
    options?.files.map((file) => file.url),
    [
      "drevo:tree-pdf:current",
      "drevo:tree-pdf:all",
      "/api/ai/export/gedcom?format=gedcom7",
      "/api/ai/export/lineage?personId=person-1&direction=ancestors",
    ],
  );
  assert.deepEqual(requestedArchiveExport("Экспорт всего древа в PDF")?.files, [
    { name: "PDF всего древа", url: "drevo:tree-pdf:all" },
  ]);
  assert.deepEqual(requestedArchiveExport("Скачай GEDCOM 5.5.1")?.files, [
    { name: "GEDCOM 5.5.1", url: "/api/ai/export/gedcom?format=gedcom551" },
  ]);
});

test("lineage needs a selected person and unrelated PDF still uses research PDF", () => {
  assert.equal(
    requestedArchiveExport("Сделай роспись предков")?.files.length,
    0,
  );
  assert.deepEqual(
    requestedArchiveExport("Сделай роспись потомков", "person/1")?.files,
    [
      {
        name: "Роспись потомков",
        url: "/api/ai/export/lineage?personId=person%2F1&direction=descendants",
      },
    ],
  );
  assert.equal(requestedArchiveExport("Сделай PDF-отчёт о человеке"), null);
  assert.deepEqual(
    requestedArchiveExport("Экспорт древа в PDF", undefined, false)?.files,
    [],
  );
});
