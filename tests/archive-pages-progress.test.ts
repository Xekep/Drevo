import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveProgressBatchSize,
  completeArchive,
} from "../src/data/archive-pages.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string): Person => ({
  id,
  surname: "Тест",
  name: id,
  patronymic: "",
  sex: "u",
  birth: "1950",
  birthPlace: "",
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
});

test("completeArchive batches React-facing progress while keeping every page", async () => {
  const people = Array.from({ length: 200 }, (_, index) => person(`p${index}`));
  const family: Family = {
    title: "Большой архив",
    description: "",
    demo: false,
    people,
    photos: [],
  };
  const pageSize = 40,
    requestedOffsets: number[] = [],
    snapshots: Family[] = [];
  const initial = {
    family,
    revision: 7,
    partial: true,
    pageToken: "7:1:1",
    totals: { people: people.length, photos: 0 },
  };

  const result = await completeArchive(
    initial,
    async (url) => {
      const parsed = new URL(url, "https://drevo.test"),
        offset = Number(parsed.searchParams.get("offset"));
      requestedOffsets.push(offset);
      const items = people.slice(offset, offset + pageSize).map((item) => ({
        id: item.id,
        sources: [
          { title: `Источник ${item.id}`, type: "archive", reference: item.id },
        ],
      }));
      return Response.json({
        pageToken: initial.pageToken,
        total: people.length,
        items,
      });
    },
    (next) => snapshots.push(next),
  );

  assert.equal(archiveProgressBatchSize, 160);
  assert.deepEqual(requestedOffsets, [0, 40, 80, 120, 160]);
  assert.equal(
    snapshots.length,
    2,
    "пять сетевых страниц публикуются в React только двумя пакетами",
  );
  assert.equal(snapshots[0].people[0].sources[0].reference, "p0");
  assert.equal(snapshots[1].people[199].sources[0].reference, "p199");
  assert.equal(result.partial, false);
  assert.equal(result.family.people[199].sources[0].reference, "p199");
});
