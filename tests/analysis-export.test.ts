import test from "node:test";
import assert from "node:assert/strict";
import { analysisExport } from "../src/domain/analysis-export.ts";
import type { Family } from "../src/domain/types.ts";

test("analysis export retains genealogy and sources, excludes media and internal fields", () => {
  const family: Family = {
    title: "Архив",
    description: "История семьи",
    demo: false,
    people: [
      {
        id: "p",
        surname: "Тестова",
        name: "Анна",
        patronymic: "Ивановна",
        sex: "f",
        birth: "1900-05",
        death: "1980",
        birthPlace: "Историческое место",
        deathPlace: "Другое место",
        birthLocation: { place: "Историческое место", lat: 55, lon: 60 },
        maidenName: "Примерова",
        occupation: "Учитель",
        biography: "Биография",
        parents: ["father"],
        spouses: ["spouse"],
        parentageComplete: false,
        sources: [
          {
            title: "Запись",
            type: "archive",
            reference: "Фонд 1",
            url: "https://example.org/source",
            note: "Примечание",
          },
        ],
        photo: "/media/portrait.jpg",
        createdBy: "oauth-id",
        generation: 4,
        column: 7,
      },
    ],
    photos: [
      {
        id: "photo",
        url: "/media/album.jpg",
        title: "Фото",
        tags: [{ id: "tag", personId: "p", x: 0, y: 0, width: 1, height: 1 }],
      },
    ],
    links: [
      {
        id: "link",
        from: "godmother",
        to: "p",
        type: "godparent",
        note: "Метрическая книга",
        createdBy: "oauth-id",
      },
    ],
  };
  const before = structuredClone(family);
  const result = analysisExport(family, 42, "2026-09-09T00:00:00.000Z");
  assert.equal(result.revision, 42);
  assert.equal(result.version, 1);
  assert.equal(result.exportedAt, "2026-09-09T00:00:00.000Z");
  const { photo, createdBy, generation, column, ...genealogy } =
    family.people[0];
  assert.ok(photo && createdBy && generation && column);
  assert.deepEqual(JSON.parse(JSON.stringify(result.people[0])), genealogy);
  assert.deepEqual(result.links, [
    {
      id: "link",
      from: "godmother",
      to: "p",
      type: "godparent",
      note: "Метрическая книга",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /\/media\/|oauth-id|"photos"|"tags"|"createdBy"|"generation"|"column"/,
  );
  assert.deepEqual(family, before);
});
