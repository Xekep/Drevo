import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import { peopleSearchStore } from "../src/server/people-search.ts";
import { scopedArchiveReader } from "../src/server/scoped-archive-reader.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import { archiveOverview } from "../src/domain/archive-projection.ts";
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
    const overview = await store.scopedOverview(user);
    const expectedOverview = archiveOverview(projected);
    assert.deepEqual(JSON.parse(JSON.stringify(overview.family)), JSON.parse(JSON.stringify(expectedOverview)));
    assert.deepEqual(overview.totals, { people: ids.size, photos: 2 });
    assert.equal(overview.revision, 1);
    overview.family.people[0].name = "Changed caller copy";
    assert.notEqual((await store.scopedOverview(user)).family.people[0].name, "Changed caller copy");
    const otherAnchor = await store.scopedOverview({ ...user, personId: "hidden" });
    assert.deepEqual(otherAnchor.family.people.map(p => p.id), ["hidden", "own"]);
    assert.ok(!(await store.scopedOverview(user)).family.people.some(p => p.id === "hidden"));
    const next = structuredClone(full);
    next.people.push({ ...person("new"), createdBy: "reader" });
    await store.write(next, 1);
    const newer = await scope(user);
    assert.notEqual(newer, ids);
    assert.ok(newer.has("new"));
    assert.equal((await search("Пример new", newer)).people[0]?.id, "new");
    assert.ok((await store.scopedOverview(user)).family.people.some(p => p.id === "new"));
  } finally {
    await store.close();
  }
});

test("scoped overview reads only permitted JSON rows and never loads a complete snapshot", async () => {
  const store = await openArchive(":memory:", { ...family, people: [
    ...family.people, ...Array.from({ length: 1000 }, (_, i) => ({ ...person(`hidden-${i}`), biography: "x".repeat(1000) })),
  ] });
  try {
    const expected = archiveOverview(projectFamilyForUser((await store.read()).family, user));
    store.read = async () => { throw new Error("Full snapshot forbidden"); };
    store.overview = async () => { throw new Error("Unscoped overview forbidden"); };
    const prepare = store.db.prepare.bind(store.db);
    let peopleRows = 0, relationRows = 0;
    store.db.prepare = (sql, pg) => {
      const statement = prepare(sql, pg);
      if (!sql.startsWith("SELECT json_set") && !sql.startsWith("SELECT * FROM relations")) return statement;
      assert.match(sql, / IN \(SELECT value FROM json_each\(\?\)\)/);
      return { ...statement, all: async (...args) => {
        const rows = await statement.all(...args);
        if (sql.startsWith("SELECT json_set")) peopleRows += rows.length;
        else relationRows += rows.length;
        return rows;
      } };
    };
    const result = await store.scopedOverview(user);
    assert.deepEqual(JSON.parse(JSON.stringify(result.family)), JSON.parse(JSON.stringify(expected)));
    assert.equal(peopleRows, expected.people.length);
    assert.ok(relationRows < 10);
    assert.ok(!JSON.stringify(result).includes("hidden-"));
    const none = await store.scopedOverview({ ...user, id: "other", personId: undefined });
    assert.deepEqual(none.family.people, []);
    assert.deepEqual(none.family.links, []);
    assert.deepEqual(none.totals, { people: 0, photos: 0 });
  } finally { await store.close(); }
});
test("scoped overview cannot publish uncommitted cards or retain a failed load", async () => {
  const store = await openArchive(":memory:", family);
  try {
    const initial = await store.scopedOverview(user);
    await assert.rejects(store.db.transaction(async () => {
      await store.db.prepare("INSERT INTO people(id,data) VALUES(?,?)").run("rolled-back", JSON.stringify({ ...person("rolled-back"), createdBy: user.id }));
      await store.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
      assert.ok((await store.scopedOverview(user)).family.people.some(p => p.id === "rolled-back"));
      throw new Error("Rollback");
    }), /Rollback/);
    assert.deepEqual(await store.scopedOverview(user), initial);
    const prepare = store.db.prepare.bind(store.db);
    let fail = true;
    store.db.prepare = (sql, pg) => {
      const statement = prepare(sql, pg);
      if (!sql.startsWith("SELECT json_set")) return statement;
      return { ...statement, all: async (...args) => {
        if (fail) { fail = false; throw new Error("Temporary overview failure"); }
        return statement.all(...args);
      } };
    };
    const newScope = { ...user, personId: "hidden" };
    await assert.rejects(store.scopedOverview(newScope), /Temporary overview failure/);
    assert.deepEqual((await store.scopedOverview(newScope)).family.people.map(p => p.id), ["hidden", "own"]);
  } finally { await store.close(); }
});

test("wide scope misses share the base overview after the per-member LRU fills", async () => {
  const store = await openArchive(":memory:", family);
  try {
    await store.overview();
    const prepare = store.db.prepare.bind(store.db);
    let wideJsonReads = 0;
    store.db.prepare = (sql, pg) => {
      const statement = prepare(sql, pg);
      if (!sql.startsWith("SELECT json_set") || sql.includes(" WHERE id IN")) return statement;
      return { ...statement, all: async (...args) => { wideJsonReads++; return statement.all(...args); } };
    };
    for (let i = 0; i < 24; i++) {
      const result = await store.scopedOverview({ ...user, id: `member-${i}` });
      assert.deepEqual(result.family.people.map(p => p.id), ["father", "mother", "child", "partner"]);
    }
    assert.equal(wideJsonReads, 0, "new members must not each reread nearly the whole archive");
  } finally { await store.close(); }
});

test("a graph commit between scope selection and a shared overview cannot reuse old permissions", async () => {
  const store = await openArchive(":memory:", family);
  try {
    const original = await store.read(), next = structuredClone(original.family);
    next.people.find(p => p.id === "child")!.parents = [];
    const transaction = store.db.transaction.bind(store.db);
    let changed = false;
    store.db.transaction = async (work, readOnly, options) => {
      const result = await transaction(work, readOnly, options);
      if (!changed && result && typeof result === "object" && "visible" in result && !store.db.inTransaction()) {
        changed = true;
        await store.write(next, original.revision);
      }
      return result;
    };
    const overview = await store.scopedOverview(user);
    assert.equal(changed, true);
    assert.equal(overview.revision, original.revision + 1);
    assert.deepEqual(overview.family.people.map(p => p.id), ["child", "partner", "own"]);
    assert.deepEqual(overview.family.people.find(p => p.id === "child")!.parents, []);
    assert.deepEqual(await store.scopedOverview(user), overview);
  } finally { await store.close(); }
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
