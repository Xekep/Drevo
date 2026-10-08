import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import { peopleSearchStore } from "../src/server/people-search.ts";
import { scopedArchiveReader } from "../src/server/scoped-archive-reader.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import type { Family, Person } from "../src/domain/types.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

const person = (
  id: string,
  parents: string[] = [],
  spouses: string[] = [],
): Person => ({
  id,
  name: id,
  surname: "Пример",
  patronymic: "",
  sex: "u",
  birth: "1950",
  birthPlace: "",
  parents,
  spouses,
  sources: [],
  generation: 1,
  column: 0,
});
const user: ArchiveUser = {
  id: "reader",
  name: "Читатель",
  role: "reader",
  approved: true,
  createdAt: "2026-01-01",
  treeAccess: "common_ancestors",
  personId: "child",
};
const family: Family = {
  title: "Проверка",
  description: "",
  demo: false,
  people: [
    person("father"),
    person("mother"),
    person("child", ["father", "mother"], ["partner"]),
    person("partner"),
    person("hidden"),
    { ...person("own"), createdBy: "reader" },
  ],
  photos: [
    {
      id: "mixed",
      url: "/media/a.jpg",
      title: "Общее",
      tags: ["child", "hidden"].map((id, i) => ({
        id,
        personId: id,
        x: i / 2,
        y: 0,
        width: 0.5,
        height: 1,
      })),
    },
    {
      id: "private",
      url: "/media/b.jpg",
      title: "Чужое",
      tags: [{ id: "h", personId: "hidden", x: 0, y: 0, width: 1, height: 1 }],
    },
    {
      id: "own",
      url: "/media/c.jpg",
      title: "Своё",
      createdBy: "reader",
      tags: [],
    },
  ],
};
test("SQL pages and cached graph scope match the established full-snapshot projection", async () => {
  const store = await openArchive(":memory:", family);
  try {
    const full = (await store.read()).family;
    const projected = projectFamilyForUser(full, user);
    const scope = scopedArchiveReader(store);
    const ids = await scope(user);
    assert.deepEqual([...ids].sort(), projected.people.map((p) => p.id).sort());
    assert.ok(ids.has("partner"));
    assert.ok(ids.has("own"));
    assert.ok(!ids.has("hidden"));
    assert.equal(
      await scope(user),
      ids,
      "same revision shares one graph projection",
    );
    const page = await store.peoplePage(1, 2, ids);
    assert.deepEqual(
      page.map((p) => p.id),
      projected.people.slice(1, 3).map((p) => p.id),
    );
    const photos = await store.photoPage(0, 100, {
      visible: ids,
      userId: user.id,
    });
    assert.deepEqual(
      photos.map((p) => p.id),
      projected.photos!.map((p) => p.id),
    );
    assert.equal(await store.photoCount({ visible: ids, userId: user.id }), 2);
    assert.deepEqual(
      photos[0].tags.map((t) => t.personId),
      ["child"],
    );
    const search = peopleSearchStore(store.db);
    assert.deepEqual((await search("Пример hidden", ids)).people, []);
    assert.equal((await search("Пример child", ids)).people[0]?.id, "child");
    const next = structuredClone(full);
    next.people.push({ ...person("new"), createdBy: "reader" });
    await store.write(next, 1);
    const newer = await scope(user);
    assert.notEqual(newer, ids);
    assert.ok(newer.has("new"));
    assert.equal((await search("Пример new", newer)).people[0]?.id, "new");
  } finally {
    await store.close();
  }
});
test("search retries a failed index load instead of caching its rejection forever", async () => {
  const store = await openArchive(":memory:", family);
  try {
    const prepare = store.db.prepare.bind(store.db);
    let fail = true;
    store.db.prepare = (sql, pg) => {
      const statement = prepare(sql, pg);
      if (!sql.includes("json_object(")) return statement;
      return {
        ...statement,
        all: async (...args) => {
          if (fail) {
            fail = false;
            throw new Error("temporary read failure");
          }
          return statement.all(...args);
        },
      };
    };
    const search = peopleSearchStore(store.db);
    await assert.rejects(search("Пример child"), /temporary/);
    assert.equal((await search("Пример child")).people[0]?.id, "child");
  } finally {
    await store.close();
  }
});
