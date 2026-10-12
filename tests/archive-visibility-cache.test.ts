import test from "node:test";
import assert from "node:assert/strict";
import { openArchive, readArchive } from "../src/server/database.ts";
import { archiveVisibilityReader } from "../src/server/archive-visibility-cache.ts";
import { peopleSearchStore } from "../src/server/people-search.ts";
import {
  archiveSnapshotBudget,
  archiveCacheView,
} from "../src/server/archive-read-cache.ts";
import type { Person, Family } from "../src/domain/types.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

const person = (id: string, createdBy?: string): Person => ({
  id,
  name: id,
  surname: "Test",
  patronymic: "",
  sex: "m",
  birth: "1980",
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
  createdBy,
});
const family: Family = {
  title: "",
  description: "",
  demo: false,
  people: [
    person("root"),
    { ...person("child"), birth: "2000", parents: ["root", "partner"] },
    { ...person("partner"), parents: ["partner-parent"] },
    { ...person("partner-parent"), birth: "1960" },
    person("island", "someone-else"),
  ],
  links: [],
  photos: [],
};
const user = (id = "alice"): ArchiveUser => ({
  id,
  name: id,
  role: "reader",
  treeRole: "reader",
  archiveOwner: false,
  createdAt: "",
  approved: true,
  treeAccess: "common_ancestors",
  personId: "root",
});

test("100 scoped readers reuse a graph across endpoints without the old 16-user cache cliff", async () => {
  const archive = await openArchive(":memory:", family);
  const budget = archiveCacheView(archiveSnapshotBudget());
  let loads = 0;
  const read = archiveVisibilityReader(
    archive.db,
    () => {
      loads++;
      return archive.db.transaction(() => readArchive(archive.db), true);
    },
    budget,
  );
  try {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        archive.db.transaction(async () => {
          const ids = await read(user(`reader-${i}`));
          assert.deepEqual([...ids].sort(), ["child", "partner", "root"]);
        }, true),
      ),
    );
    assert.equal(loads, 1);
    for (let i = 0; i < 100; i++) await read(user(`reader-${i}`));
    assert.equal(loads, 1);
    const otherScope = await read({ ...user(), personId: "partner-parent" });
    assert.ok(otherScope.has("partner-parent"));
    assert.ok(!(await read(user())).has("partner-parent"));
  } finally {
    read.close();
    budget.close();
    await archive.close();
  }
});

test("writer visibility bypasses committed caches and rollback cannot poison another reader", async () => {
  const archive = await openArchive(":memory:", family);
  const budget = archiveCacheView(archiveSnapshotBudget());
  const read = archiveVisibilityReader(
    archive.db,
    () => archive.db.transaction(() => readArchive(archive.db), true),
    budget,
  );
  try {
    assert.ok(!(await read(user())).has("island"));
    await assert.rejects(
      archive.db.transaction(async () => {
        assert.equal(archive.db.canReuseGraphCache(), false);
        await archive.db
          .prepare(
            "UPDATE people SET data=json_set(data,'$.createdBy',?) WHERE id=?",
          )
          .run("alice", "island");
        assert.ok((await read(user())).has("island"));
        throw new Error("rollback graph");
      }),
      /rollback graph/,
    );
    assert.ok(!(await read(user())).has("island"));
    await archive.db.transaction(
      async () => {
        assert.equal(archive.db.canReuseGraphCache(), true);
        assert.ok(!(await read(user())).has("island"));
      },
      false,
      { archiveLock: "share", graphReadOnly: true },
    );
  } finally {
    read.close();
    budget.close();
    await archive.close();
  }
});

test("search uses bounded derived storage, observes writer edits and frees everything with the runtime", async () => {
  const archive = await openArchive(":memory:", family);
  const budget = archiveCacheView(archiveSnapshotBudget(100_000));
  const search = peopleSearchStore(archive.db, budget);
  try {
    assert.equal((await search("island")).people[0]?.id, "island");
    assert.ok(budget.diagnostics().bytes > 0);
    await assert.rejects(
      archive.db.transaction(async () => {
        await archive.db
          .prepare(
            "UPDATE people SET data=json_set(data,'$.name',?) WHERE id=?",
          )
          .run("temporary-name", "island");
        assert.equal((await search("temporary-name")).people[0]?.id, "island");
        throw new Error("rollback search");
      }),
      /rollback search/,
    );
    assert.equal((await search("temporary-name")).people.length, 0);
    budget.close();
    assert.equal(budget.diagnostics().bytes, 0);
    assert.equal((await search("island")).people[0]?.id, "island");
    assert.equal(budget.diagnostics().bytes, 0);
  } finally {
    search.close();
    budget.close();
    await archive.close();
  }
});
