import test from "node:test";
import assert from "node:assert/strict";
import { openArchive, ConflictError } from "../src/server/database.ts";
import { patchPeople } from "../src/server/person-patches.ts";
import type { StoreDatabase } from "../src/server/store-database.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family } from "../src/domain/types.ts";

test("batch card validation keeps all relatives without per-person database reads", async () => {
  const family: Family = {
    title: "Тест пакета",
    description: "",
    demo: false,
    people: Array.from({ length: 1000 }, (_, i) => ({
      id: `p-${i}`,
      name: `Человек ${i}`,
      surname: "Тестов",
      patronymic: "",
      sex: "m",
      birth: i % 2 ? "1980" : "1950",
      birthPlace: "",
      parents: i % 2 ? [`p-${i - 1}`] : [],
      spouses: [],
      sources: [],
      generation: (i % 2) + 1,
      column: i,
      createdBy: "owner",
    })),
  };
  const actor: ArchiveUser = {
    id: "owner",
    name: "Владелец",
    role: "admin",
    approved: true,
    createdAt: "",
  };
  const archive = await openArchive(":memory:", family);
  let peopleReads = 0;
  const counted: StoreDatabase = {
    ...archive.db,
    prepare(sqlite, postgres) {
      const statement = archive.db.prepare(sqlite, postgres);
      if (!/^SELECT .* FROM people/i.test(sqlite)) return statement;
      return {
        ...statement,
        get: async (...args) => {
          peopleReads++;
          return statement.get(...args);
        },
        all: async (...args) => {
          peopleReads++;
          return statement.all(...args);
        },
      };
    },
  };
  try {
    const initial = await archive.read();
    const changes = family.people
      .filter((p) => !p.parents.length)
      .map((p) => ({
        collection: "people" as const,
        id: p.id,
        field: "biography",
        before: undefined,
        after: "Проверено",
      }));
    const result = await patchPeople(counted, changes, initial.revision, actor);
    assert.ok(result);
    assert.equal(
      peopleReads,
      1,
      "500 edited cards plus 500 relatives need one set read",
    );
    assert.equal(result.appliedChanges.length, 500);
    const after = await archive.read();
    assert.equal(after.revision, initial.revision + 1);
    for (const person of after.family.people) {
      assert.equal(
        person.biography,
        person.parents.length ? undefined : "Проверено",
      );
      assert.deepEqual(
        person.parents,
        family.people.find((p) => p.id === person.id)!.parents,
      );
    }
    // The last unedited child still participates in date validation.
    await assert.rejects(
      () =>
        patchPeople(
          counted,
          [
            {
              collection: "people",
              id: "p-998",
              field: "birth",
              before: "1950",
              after: "1990",
            },
          ],
          after.revision,
          actor,
        ),
      /раньше ребёнка/,
    );
    assert.equal((await archive.meta()).revision, after.revision);
    await assert.rejects(
      () =>
        patchPeople(
          counted,
          [{ ...changes[0], id: "missing" }],
          after.revision,
          actor,
        ),
      ConflictError,
    );
    assert.equal((await archive.meta()).revision, after.revision);
    assert.deepEqual(
      (await archive.readRevision(initial.revision)).people,
      initial.family.people,
    );
  } finally {
    await archive.close();
  }
});
