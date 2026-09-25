import test from "node:test";
import assert from "node:assert/strict";
import {
  completeArchive,
  type ArchivePageHeader,
} from "../src/data/archive-pages.ts";
import type { Person } from "../src/domain/types.ts";

const person: Person = {
  id: "p",
  name: "Иван",
  surname: "Тестов",
  patronymic: "",
  birth: "1950",
  birthPlace: "",
  sex: "m",
  generation: 1,
  column: 0,
  sources: [],
  parents: [],
  spouses: [],
};
const initial: ArchivePageHeader = {
  family: {
    title: "Архив",
    description: "",
    demo: false,
    people: [person],
    photos: [],
  },
  revision: 1,
  partial: true,
  pageToken: "old",
  totals: { people: 1, photos: 0 },
};
test("initial hydration recovers from a concurrent write with one consistent snapshot", async () => {
  const fresh = {
    ...initial,
    partial: false,
    revision: 2,
    family: { ...initial.family, people: [{ ...person, name: "Пётр" }] },
    canEdit: false,
  };
  const urls: string[] = [];
  const result = await completeArchive(
    initial,
    async (url) => {
      urls.push(url);
      return url === "/api/family"
        ? Response.json(fresh)
        : Response.json({ error: "Changed" }, { status: 409 });
    },
    () => assert.fail("No incomplete revision should be published"),
  );
  assert.deepEqual(result, fresh);
  assert.equal(urls.filter((url) => url === "/api/family").length, 1);
});
test("hydration recovery does not keep old data or loop after access is revoked", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      completeArchive(
        initial,
        async (url) => {
          calls++;
          return url === "/api/family"
            ? Response.json({ error: "Access revoked" }, { status: 401 })
            : Response.json({}, { status: 409 });
        },
        () => assert.fail("Old data must not be published"),
      ),
    /Access revoked/,
  );
  assert.equal(calls, 2);
});
