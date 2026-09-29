import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive, readArchive } from "../src/server/database.ts";
import { archiveSnapshotReader } from "../src/server/archive-read-cache.ts";
import type { Family } from "../src/domain/types.ts";

const family: Family = {
  title: "Архив",
  description: "",
  demo: false,
  people: [
    {
      id: "person",
      name: "Иван",
      surname: "Тестов",
      patronymic: "",
      sex: "m",
      birth: "1980",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [
        {
          title: "Источник",
          type: "Документ",
          reference: "1",
          url: "https://example.org",
        },
      ],
      generation: 1,
      column: 0,
      photo: "/media/portrait.png",
      biography: "Биография",
    },
  ],
  photos: [],
  links: [],
};
const gate = () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
};

test("concurrent snapshots share a load but never mutable objects or view variants", async () => {
  const archive = await openArchive(":memory:", family);
  const ready = gate(),
    proceed = gate();
  let loads = 0;
  const read = archiveSnapshotReader(archive.db, async () => {
    loads++;
    ready.release();
    await proceed.wait;
    return archive.db.transaction(() => readArchive(archive.db), true);
  });
  try {
    const requests = Array.from({ length: 30 }, () => read());
    await ready.wait;
    await new Promise<void>((resolve) => setImmediate(resolve));
    proceed.release();
    const results = await Promise.all(requests);
    assert.equal(loads, 1);
    results[0].family.people[0].sources[0].title = "Изменено";
    results[0].family.people.length = 0;
    assert.equal(results[1].family.people[0].sources[0].title, "Источник");
    assert.equal((await read()).family.people.length, 1);
    assert.equal(loads, 1);
    const [full, portraits, hidden] = await Promise.all([
      archive.read(),
      archive.overview(true),
      archive.overview(false),
    ]);
    assert.equal(full.family.people[0].biography, "Биография");
    assert.deepEqual(
      full,
      await archive.db.transaction(() => readArchive(archive.db), true),
    );
    assert.equal(portraits.family.people[0].photo, "/media/portrait.png");
    assert.equal(hidden.family.people[0].photo, undefined);
    assert.equal(portraits.family.people[0].biography, undefined);
    assert.deepEqual(await archive.read(), full);
  } finally {
    proceed.release();
    await archive.close();
  }
});

test("a second store's committed write invalidates cached snapshots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-read-cache-"));
  const file = join(directory, "test.sqlite");
  const first = await openArchive(file, family),
    second = await openArchive(file, family);
  try {
    const before = await first.read();
    await first.overview();
    const changed = structuredClone(before.family);
    changed.people[0].name = "Новое имя";
    await second.write(changed, before.revision);
    assert.equal((await first.read()).family.people[0].name, "Новое имя");
    assert.equal((await first.overview()).revision, before.revision + 1);
  } finally {
    await first.close();
    await second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a transaction reads its own changes and rollback cannot poison the snapshot cache", async () => {
  const archive = await openArchive(":memory:", family);
  try {
    const before = await archive.read();
    await assert.rejects(
      archive.db.transaction(async () => {
        await archive.db
          .prepare("UPDATE archive SET description='uncommitted'")
          .run();
        assert.equal((await archive.read()).family.description, "uncommitted");
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.deepEqual(await archive.read(), before);
    let detached!: Promise<unknown>;
    await archive.db.transaction(async () => {
      detached = new Promise<void>((resolve, reject) =>
        setImmediate(() => {
          assert
            .rejects(archive.read(), /Контекст|контекст/)
            .then(resolve, reject);
        }),
      );
    });
    await detached;
  } finally {
    await archive.close();
  }
});

test("an older delayed snapshot never evicts a newer revision", async () => {
  const archive = await openArchive(":memory:", family);
  const ready = gate(),
    proceed = gate();
  let loads = 0;
  const read = archiveSnapshotReader(archive.db, async () => {
    const snapshot = await archive.db.transaction(
      () => readArchive(archive.db),
      true,
    );
    if (++loads === 1) {
      ready.release();
      await proceed.wait;
    }
    return snapshot;
  });
  try {
    const old = read();
    await ready.wait;
    const initial = await archive.read();
    await archive.write(
      { ...initial.family, description: "new" },
      initial.revision,
    );
    assert.equal((await read()).family.description, "new");
    proceed.release();
    assert.equal((await old).revision, initial.revision);
    assert.equal((await read()).family.description, "new");
    assert.equal(loads, 2);
  } finally {
    proceed.release();
    await archive.close();
  }
});

test("failed reads can retry and oversized snapshots are not retained", async () => {
  const archive = await openArchive(":memory:", family);
  let attempts = 0;
  const read = archiveSnapshotReader(
    archive.db,
    async () => {
      if (++attempts === 1) throw new Error("database unavailable");
      return archive.db.transaction(() => readArchive(archive.db), true);
    },
    1,
  );
  try {
    await assert.rejects(read(), /database unavailable/);
    assert.equal((await read()).family.people.length, 1);
    assert.equal((await read()).family.people.length, 1);
    assert.equal(attempts, 3);
  } finally {
    await archive.close();
  }
});
