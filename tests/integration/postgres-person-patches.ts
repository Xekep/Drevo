import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { Family, Person } from "../../src/domain/types.ts";
import { inverseChanges, type Change } from "../../src/domain/changes.ts";
import { archiveRows } from "../../src/server/archive-rows.ts";
import { openArchive } from "../../src/server/database.ts";
import { auditStore } from "../../src/server/audit.ts";
import { postgresAuditReader } from "../../src/server/postgres-audit-read.ts";
import { readPostgresArchive } from "../../src/server/postgres-archive-read.ts";
import { patchPostgresPeopleForSession as patch } from "../../src/server/postgres-person-patches.ts";
import { sessionTokenHash } from "../../src/server/session-token.ts";
import { ForbiddenError } from "../../src/server/users.ts";
import { ConflictError } from "../../src/server/archive-errors.ts";

// Never run against the working archive or an imported snapshot. Each test has
// a new schema and synthetic data in an explicitly named disposable database.
if (
  !/^drevo_migration_person_patches(?:_[a-z0-9_]+)?$/.test(
    process.env.PGDATABASE || "",
  )
)
  throw new Error(
    "PGDATABASE must be a disposable drevo_migration_person_patches database",
  );

const tokens = {
  admin: "a".repeat(64),
  relative: "b".repeat(64),
  reader: "c".repeat(64),
  outsider: "d".repeat(64),
};
const actor = {
  id: "admin",
  name: "Администратор",
  role: "admin" as const,
  approved: true,
  createdAt: "2026-01-01",
};
const person = (id: string, birth: string, parents: string[] = []): Person => ({
  id,
  name: id,
  surname: "Тест",
  patronymic: "",
  sex: "m",
  birth,
  birthPlace: "",
  parents,
  spouses: [],
  sources: [],
  generation: parents.length ? 2 : 1,
  column: 0,
  createdBy: id === "child" || id === "own" ? "relative" : "admin",
});
const family: Family = {
  title: "Проверка",
  description: "",
  demo: false,
  people: [
    person("father", "1950"),
    person("child", "1980", ["father"]),
    person("own", "2000"),
  ],
  photos: [
    {
      id: "photo",
      url: "/media/photo.png",
      title: "Фото",
      tags: [{ id: "tag", personId: "child", x: 0, y: 0, width: 1, height: 1 }],
    },
  ],
  links: [],
};
const change = (
  field: string,
  before: unknown,
  after: unknown,
  id = "father",
): Change[] => [{ collection: "people", id, field, before, after }];

async function fixture(t: TestContext) {
  const schema = `patch_${randomUUID().replaceAll("-", "")}`;
  const clients: pg.Client[] = [];
  const first = new pg.Client({ connectionTimeoutMillis: 5000 });
  await first.connect();
  clients.push(first);
  t.after(async () => {
    // Release any locks even if an assertion in a concurrency test failed.
    await Promise.all(
      clients.map((client) => client.query("ROLLBACK").catch(() => {})),
    );
    try {
      await first.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });
  const actual = (await first.query("SELECT current_database() AS name"))
    .rows[0].name;
  assert.equal(actual, process.env.PGDATABASE);
  await first.query(`CREATE SCHEMA ${schema}`);
  for (let index = 0; index < 3; index++) {
    if (index) {
      const client = new pg.Client({ connectionTimeoutMillis: 5000 });
      await client.connect();
      clients.push(client);
    }
    await clients[index].query(`SET search_path TO ${schema},pg_catalog`);
  }
  for (const file of [
    "001_archive_core.sql",
    "003_archive_access.sql",
    "004_archive_audit.sql",
  ])
    await first.query(
      readFileSync(
        new URL(`../../ops/postgres/${file}`, import.meta.url),
        "utf8",
      ),
    );
  for (const [id, token] of Object.entries(tokens)) {
    await first.query(
      "INSERT INTO accounts(id,name,created_at) VALUES($1,$2,$3)",
      [id, id === "admin" ? actor.name : id, "2026-01-01"],
    );
    await first.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [sessionTokenHash(token), id, Date.now() + 60_000],
    );
  }
  const rows = archiveRows(family);
  for (const archiveId of ["tree-a", "tree-b"]) {
    await first.query(
      "INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version) VALUES($1,$2,'',false,0,1)",
      [archiveId, family.title],
    );
    for (const [index, row] of rows.people.entries())
      await first.query(
        "INSERT INTO people(archive_id,id,ordinal,data) VALUES($1,$2,$3,$4::jsonb)",
        [archiveId, row.id, index, row.data],
      );
    for (const [index, row] of rows.relations.entries())
      await first.query(
        "INSERT INTO relations(archive_id,id,ordinal,source,target,type) VALUES($1,$2,$3,$4,$5,$6)",
        [archiveId, row.id, index, row.source, row.target, row.type],
      );
    for (const [index, row] of rows.photos.entries())
      await first.query(
        "INSERT INTO photos(archive_id,id,ordinal,data) VALUES($1,$2,$3,$4::jsonb)",
        [archiveId, row.id, index, row.data],
      );
    for (const [index, row] of rows.tags.entries())
      await first.query(
        "INSERT INTO photo_tags(archive_id,id,ordinal,photo_id,person_id,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
        [archiveId, row.id, index, row.photoId, row.personId, row.data],
      );
    for (const role of ["admin", "relative", "reader"])
      await first.query(
        "INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES($1,$2,$2,true,'all')",
        [archiveId, role],
      );
  }
  return { first, second: clients[1], third: clients[2] };
}

async function fingerprint(client: pg.Client, archiveId = "tree-a") {
  const tables = [
    "archives",
    "people",
    "relations",
    "photos",
    "photo_tags",
    "history",
    "archive_audit_entries",
    "archive_audit_people",
  ];
  const rows = [];
  for (const table of tables)
    rows.push(
      (
        await client.query(
          `SELECT row_to_json(t)::text AS row FROM ${table} t WHERE ${table === "archives" ? "id" : "archive_id"}=$1 ORDER BY row_to_json(t)::text`,
          [archiveId],
        )
      ).rows,
    );
  return rows;
}

async function waitForLock(observer: pg.Client, blocked: pg.Client) {
  const pid = (blocked as unknown as { processID: number }).processID;
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const row = (
      await observer.query(
        "SELECT cardinality(pg_blocking_pids($1)) AS blockers",
        [pid],
      )
    ).rows[0];
    if (Number(row.blockers) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Writer did not reach the expected database lock");
}

test("PostgreSQL matches SQLite patches, audit and inverse changes without rewriting unrelated rows", async (t) => {
  const { first } = await fixture(t);
  const sqlite = openArchive(":memory:", family);
  t.after(() => sqlite.close());
  // Both stores start at the same revision; SQLite seeds the first revision.
  await first.query("UPDATE archives SET revision=$1 WHERE id='tree-a'", [
    sqlite.read().revision,
  ]);
  const untouched = (
    await first.query(
      "SELECT id,xmin::text FROM people WHERE archive_id='tree-a' AND id<>'father' ORDER BY id",
    )
  ).rows;
  const otherArchive = await fingerprint(first, "tree-b");
  const changes = [
    ...change("birth", "1950", "1951"),
    ...change("maidenName", undefined, "Иванов"),
    ...change(
      "sources",
      [],
      [
        {
          title: "Метрическая книга",
          type: "archive",
          reference: "Ф.6",
          url: "https://example.org/source",
          note: "Лист 12",
        },
      ],
    ),
  ];
  const pgResult = await patch(first, tokens.admin, "tree-a", changes, 0);
  const sqliteResult = sqlite.patchPeople(changes, 0, actor);
  assert.deepEqual(pgResult, sqliteResult);
  assert.deepEqual(await readPostgresArchive(first, "tree-a"), sqlite.read());
  const withoutTime = (items: Array<{ at: string }>) =>
    items.map((entry) => ({ ...entry, at: "" }));
  assert.deepEqual(
    withoutTime((await postgresAuditReader(first, "tree-a").list()).items),
    withoutTime(auditStore(sqlite.db).list().items),
  );
  assert.deepEqual(
    (
      await first.query(
        "SELECT id,xmin::text FROM people WHERE archive_id='tree-a' AND id<>'father' ORDER BY id",
      )
    ).rows,
    untouched,
  );
  assert.deepEqual(await fingerprint(first, "tree-b"), otherArchive);
  const history = (
    await first.query(
      "SELECT data FROM history WHERE archive_id='tree-a' AND revision=1",
    )
  ).rows[0].data;
  assert.deepEqual(
    history.changes,
    JSON.parse(JSON.stringify(inverseChanges(pgResult.appliedChanges))),
  );
  const retryBefore = await fingerprint(first);
  assert.deepEqual(
    (await patch(first, tokens.admin, "tree-a", changes, 0)).appliedChanges,
    [],
  );
  assert.deepEqual(await fingerprint(first), retryBefore);
  await patch(first, tokens.admin, "tree-a", history.changes, 1);
  sqlite.patchPeople(history.changes, 1, actor);
  assert.deepEqual(await readPostgresArchive(first, "tree-a"), sqlite.read());
});

test("write rejects readers, missing/expired sessions, unapproved or unrelated memberships", async (t) => {
  const { first } = await fixture(t);
  const before = await fingerprint(first);
  const changes = change("name", "father", "Новое имя");
  for (const token of ["bad", "e".repeat(64), tokens.reader, tokens.outsider])
    await assert.rejects(
      patch(first, token, "tree-a", changes, 0),
      ForbiddenError,
    );
  await assert.rejects(
    patch(first, tokens.admin, "missing", changes, 0),
    ForbiddenError,
  );
  await first.query(
    "UPDATE archive_memberships SET approved=false WHERE archive_id='tree-a' AND user_id='admin'",
  );
  await assert.rejects(
    patch(first, tokens.admin, "tree-a", changes, 0),
    ForbiddenError,
  );
  await first.query(
    "UPDATE archive_memberships SET approved=true WHERE archive_id='tree-a' AND user_id='admin'",
  );
  await first.query(
    "UPDATE account_sessions SET expires_at=0 WHERE user_id='admin'",
  );
  await assert.rejects(
    patch(first, tokens.admin, "tree-a", changes, 0),
    ForbiddenError,
  );
  assert.deepEqual(await fingerprint(first), before);
});

test("rights belong to the selected archive; scoped relatives edit only their own cards", async (t) => {
  const { first } = await fixture(t);
  await first.query(
    "UPDATE archive_memberships SET role='reader' WHERE archive_id='tree-b' AND user_id='admin'",
  );
  await assert.rejects(
    patch(first, tokens.admin, "tree-b", change("birth", "1950", "1951"), 0),
    ForbiddenError,
  );
  await first.query(
    "UPDATE archive_memberships SET tree_access='common_ancestors',person_id='own' WHERE user_id='relative'",
  );
  const before = await fingerprint(first);
  await assert.rejects(
    patch(first, tokens.relative, "tree-a", change("birth", "1950", "1951"), 0),
    ForbiddenError,
  );
  await assert.rejects(
    patch(
      first,
      tokens.relative,
      "tree-a",
      change("birth", "1950", "1951", "absent"),
      0,
    ),
    ForbiddenError,
  );
  assert.deepEqual(await fingerprint(first), before);
  const result = await patch(
    first,
    tokens.relative,
    "tree-a",
    change("birth", "2000", "2001", "own"),
    0,
  );
  assert.equal(result.revision, 1);
  assert.ok(result.appliedChanges.every((item) => item.id === "own"));
});

test("invalid dates, removed cards, future revision and mixed unauthorized batch are atomic failures", async (t) => {
  const { first } = await fixture(t);
  const before = await fingerprint(first);
  await assert.rejects(
    patch(first, tokens.admin, "tree-a", change("birth", "1950", "1981"), 0),
    /раньше ребёнка/,
  );
  await assert.rejects(
    patch(first, tokens.admin, "tree-a", change("birth", "1950", "bad"), 0),
    /карточка/,
  );
  await assert.rejects(
    patch(
      first,
      tokens.admin,
      "tree-a",
      change("name", "deleted", "Имя", "deleted"),
      0,
    ),
    ConflictError,
  );
  await assert.rejects(
    patch(first, tokens.admin, "tree-a", change("birth", "1950", "1951"), 1),
    ConflictError,
  );
  await assert.rejects(
    patch(
      first,
      tokens.relative,
      "tree-a",
      [
        ...change("birth", "2000", "2001", "own"),
        ...change("birth", "1950", "1951"),
      ],
      0,
    ),
    ForbiddenError,
  );
  assert.deepEqual(await fingerprint(first), before);
});

test("structural writes, portraits, forged authors and prototype fields are not accepted by the person operation", async (t) => {
  const { first } = await fixture(t);
  const before = await fingerprint(first);
  for (const field of [
    "parents",
    "spouses",
    "photo",
    "createdBy",
    "id",
    "__proto__",
    "constructor",
  ])
    await assert.rejects(
      patch(
        first,
        tokens.admin,
        "tree-a",
        change(field, undefined, "forged"),
        0,
      ),
      /Ожидаются изменения/,
    );
  for (const changes of [
    [],
    [
      {
        collection: "people",
        id: "new",
        before: undefined,
        after: person("new", "1990"),
      },
    ],
    [
      {
        collection: "meta",
        field: "title",
        before: "Проверка",
        after: "Новое",
      },
    ],
  ] as Change[][])
    await assert.rejects(
      patch(first, tokens.admin, "tree-a", changes, 0),
      /Ожидаются изменения/,
    );
  assert.deepEqual(await fingerprint(first), before);
});

for (const sameField of [false, true])
  test(`concurrent editors ${sameField ? "get a conflict on the same field" : "merge independent fields"}`, async (t) => {
    const { first, second, third } = await fixture(t);
    await first.query("BEGIN");
    await first.query(
      "SELECT revision FROM archives WHERE id='tree-a' FOR UPDATE",
    );
    const one = patch(
      second,
      tokens.admin,
      "tree-a",
      change("birth", "1980", "1981", "child"),
      0,
    );
    const two = patch(
      third,
      tokens.relative,
      "tree-a",
      sameField
        ? change("birth", "1980", "1982", "child")
        : change("biography", undefined, "Воспоминания", "child"),
      0,
    );
    const results = Promise.allSettled([one, two]);
    await waitForLock(first, second);
    await waitForLock(first, third);
    await first.query("COMMIT");
    const settled = await results;
    assert.equal(
      settled.filter((result) => result.status === "fulfilled").length,
      sameField ? 1 : 2,
    );
    const saved = await readPostgresArchive(first, "tree-a");
    assert.equal(saved.revision, sameField ? 1 : 2);
    const child = saved.family.people.find((person) => person.id === "child")!;
    if (sameField) {
      const failed = settled.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      assert.ok(failed.reason instanceof ConflictError);
      assert.ok(["1981", "1982"].includes(child.birth));
    } else {
      assert.equal(child.birth, "1981");
      assert.equal(child.biography, "Воспоминания");
      assert.deepEqual(
        new Set(
          (await postgresAuditReader(first, "tree-a").list()).items.map(
            (item) => item.actorId,
          ),
        ),
        new Set(["admin", "relative"]),
      );
    }
    assert.equal(
      (await postgresAuditReader(first, "tree-a").list()).items.length,
      saved.revision,
    );
  });

for (const revoke of ["membership", "session", "expiry"] as const)
  test(`queued writer rechecks ${revoke} after obtaining the archive lock`, async (t) => {
    const { first, second } = await fixture(t);
    const before = await fingerprint(first);
    await first.query("BEGIN");
    await first.query(
      "SELECT revision FROM archives WHERE id='tree-a' FOR UPDATE",
    );
    const pending = assert.rejects(
      patch(second, tokens.admin, "tree-a", change("birth", "1950", "1951"), 0),
      ForbiddenError,
    );
    await waitForLock(first, second);
    if (revoke === "membership")
      await first.query(
        "UPDATE archive_memberships SET role='reader' WHERE archive_id='tree-a' AND user_id='admin'",
      );
    else if (revoke === "session")
      await first.query("DELETE FROM account_sessions WHERE user_id='admin'");
    else
      await first.query(
        "UPDATE account_sessions SET expires_at=0 WHERE user_id='admin'",
      );
    await first.query("COMMIT");
    await pending;
    assert.deepEqual(await fingerprint(first), before);
  });

test("archive A write lock does not block archive B with the same person IDs", async (t) => {
  const { first, second, third } = await fixture(t);
  await first.query("BEGIN");
  await first.query(
    "SELECT revision FROM archives WHERE id='tree-a' FOR UPDATE",
  );
  const pending = patch(
    second,
    tokens.admin,
    "tree-a",
    change("birth", "1950", "1951"),
    0,
  );
  const settled = Promise.allSettled([pending]);
  await waitForLock(first, second);
  assert.equal(
    (
      await patch(
        third,
        tokens.admin,
        "tree-b",
        change("birth", "1950", "1952"),
        0,
      )
    ).revision,
    1,
  );
  await first.query("COMMIT");
  assert.equal((await settled)[0].status, "fulfilled");
  assert.equal(
    (await readPostgresArchive(first, "tree-a")).family.people[0].birth,
    "1951",
  );
  assert.equal(
    (await readPostgresArchive(first, "tree-b")).family.people[0].birth,
    "1952",
  );
});

test("audit failure rolls back person data, history and revision together", async (t) => {
  const { first } = await fixture(t);
  const before = await fingerprint(first);
  await first.query(`CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
    CREATE TRIGGER reject_audit BEFORE INSERT ON archive_audit_entries FOR EACH ROW EXECUTE FUNCTION reject_audit()`);
  await assert.rejects(
    patch(first, tokens.admin, "tree-a", change("birth", "1950", "1951"), 0),
    /audit unavailable/,
  );
  assert.deepEqual(await fingerprint(first), before);
  await first.query("DROP TRIGGER reject_audit ON archive_audit_entries");
  assert.equal(
    (
      await patch(
        first,
        tokens.admin,
        "tree-a",
        change("birth", "1950", "1951"),
        0,
      )
    ).revision,
    1,
  );
});

test("undo changes only its fields and rejects overwriting another editor's later value", async (t) => {
  const { first } = await fixture(t);
  const firstEdit = await patch(
    first,
    tokens.admin,
    "tree-a",
    change("birth", "1950", "1951"),
    0,
  );
  await patch(
    first,
    tokens.admin,
    "tree-a",
    change("biography", undefined, "Новые сведения"),
    0,
  );
  await patch(
    first,
    tokens.admin,
    "tree-a",
    inverseChanges(firstEdit.appliedChanges),
    1,
  );
  const result = await readPostgresArchive(first, "tree-a");
  assert.equal(result.family.people[0].birth, "1950");
  assert.equal(result.family.people[0].biography, "Новые сведения");
  await patch(
    first,
    tokens.admin,
    "tree-a",
    change("birth", "1950", "1952"),
    result.revision,
  );
  await assert.rejects(
    patch(
      first,
      tokens.admin,
      "tree-a",
      inverseChanges(firstEdit.appliedChanges),
      1,
    ),
    ConflictError,
  );
});

test("history retention affects only the edited archive", async (t) => {
  const { first } = await fixture(t);
  await first.query(
    "INSERT INTO history(archive_id,revision,saved_at,data) SELECT 'tree-a',n,'2026-01-01','{}'::jsonb FROM generate_series(0,59) n",
  );
  await first.query(
    "INSERT INTO history(archive_id,revision,saved_at,data) VALUES('tree-b',0,'2026-01-01','{}')",
  );
  await first.query("UPDATE archives SET revision=60 WHERE id='tree-a'");
  await patch(
    first,
    tokens.admin,
    "tree-a",
    change("birth", "1950", "1951"),
    60,
  );
  assert.deepEqual(
    (
      await first.query(
        "SELECT archive_id,count(*)::integer AS count,min(revision)::integer AS oldest FROM history GROUP BY archive_id ORDER BY archive_id",
      )
    ).rows,
    [
      { archive_id: "tree-a", count: 50, oldest: 11 },
      { archive_id: "tree-b", count: 1, oldest: 0 },
    ],
  );
});
