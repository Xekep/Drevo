import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type pg from "pg";
import {
  applyArchiveChanges,
  archiveChanges,
  inverseChanges,
  type Change,
} from "../../src/domain/changes.ts";
import { connectPeople, removeConnection } from "../../src/domain/mutations.ts";
import {
  archiveConnections,
  replaceConnection,
} from "../../src/domain/connections.ts";
import type { Family } from "../../src/domain/types.ts";
import { changePostgresGraphForSession as graph } from "../../src/server/postgres-graph-changes.ts";
import { patchPostgresPeopleForSession as patch } from "../../src/server/postgres-person-patches.ts";
import { readPostgresArchive as read } from "../../src/server/postgres-archive-read.ts";
import { postgresAuditReader } from "../../src/server/postgres-audit-read.ts";
import { openArchive } from "../../src/server/database.ts";
import { ForbiddenError } from "../../src/server/users.ts";
import { ConflictError } from "../../src/server/archive-errors.ts";
import {
  tokens,
  actor,
  person,
  family,
  fixture,
  fingerprint,
  waitForLock,
  change,
} from "./postgres-fixture.ts";

const draft = (id: string, birth = "2000") => ({
  ...person(id, birth),
  createdBy: undefined,
});
const add = (id: string, birth = "2000"): Change[] => [
  { collection: "people", id, before: undefined, after: draft(id, birth) },
];

test("removing a parent clears implicit completeness and undo restores the prior flag", async (t) => {
  const { first } = await fixture(t);
  await patch(
    first,
    tokens.relative,
    "tree-a",
    change("parentageComplete", undefined, true, "child"),
    0,
  );
  const result = await graph(
    first,
    tokens.relative,
    "tree-a",
    change("parents", ["father"], [], "child"),
    1,
  );
  assert.equal(
    (await read(first, "tree-a")).family.people.find((p) => p.id === "child")!
      .parentageComplete,
    false,
  );
  await graph(
    first,
    tokens.relative,
    "tree-a",
    inverseChanges(result.appliedChanges),
    2,
  );
  const child = (await read(first, "tree-a")).family.people.find(
    (p) => p.id === "child",
  )!;
  assert.equal(child.parentageComplete, true);
  assert.deepEqual(child.parents, ["father"]);
});

test("PostgreSQL retains foster, presumed and twin details across graph reads", async (t) => {
  const { first } = await fixture(t);
  const before = (await read(first, "tree-a")).family;
  let next = connectPeople(before, "father", "own", "foster_parent");
  next = connectPeople(next, "child", "own", "presumed_parent", "Гипотеза");
  next = { ...next, people: [...next.people, draft("peer", "1980")] };
  next = connectPeople(next, "child", "peer", "twin", "", "identical");
  await graph(first, tokens.admin, "tree-a", archiveChanges(before, next), 0);
  const saved = (await read(first, "tree-a")).family;
  assert.deepEqual(saved.links?.map((link) => ({ type: link.type, twinKind: link.twinKind, note: link.note })),
    next.links?.map((link) => ({ type: link.type, twinKind: link.twinKind, note: link.note })));
  assert.deepEqual(saved.people.find((p) => p.id === "own")?.parents, []);
  const changed = {
    ...saved,
    links: saved.links?.map((link) => link.type === "twin" ? { ...link, twinKind: "fraternal" as const } : link),
  };
  await graph(first, tokens.admin, "tree-a", archiveChanges(saved, changed), 1);
  assert.equal((await read(first, "tree-a")).family.links?.find((link) => link.type === "twin")?.twinKind, "fraternal");
});

test("additional link evidence has SQLite/PostgreSQL parity and cannot move to a different assertion", async (t) => {
  const { first } = await fixture(t);
  const before = (await read(first, "tree-a")).family;
  const sqlite = await openArchive(":memory:", before);
  t.after(async () => await sqlite.close());
  const after: Family = { ...before, links: [{ id: "guardianship", from: "father", to: "child",
    type: "guardian", createdBy: "admin", sources: [{ title: "Guardianship record",
      type: "archive", reference: "leaf 4" }] }] };
  await graph(first, tokens.admin, "tree-a", archiveChanges(before, after), 0);
  await sqlite.write(after, 1, actor);
  assert.deepEqual((await read(first, "tree-a")).family, (await sqlite.read()).family);
  const saved = (await read(first, "tree-a")).family;
  const annotated = { ...saved, links: saved.links!.map((link) => ({ ...link, note: "reviewed" })) };
  await graph(first, tokens.admin, "tree-a", archiveChanges(saved, annotated), 1);
  await sqlite.write(annotated, 2, actor);
  assert.deepEqual((await read(first, "tree-a")).family, (await sqlite.read()).family);
  const moved = { ...annotated, links: annotated.links!.map((link) => ({ ...link, to: "own" })) };
  await assert.rejects(graph(first, tokens.admin, "tree-a", archiveChanges(annotated, moved), 2),
    /снимите прежние источники/);
  await assert.rejects(sqlite.write(moved, 3, actor), /снимите прежние источники/);
  assert.equal((await read(first, "tree-a")).family.links?.[0].sources?.[0].reference, "leaf 4");
});

test("PostgreSQL migration extends an existing relations table without losing rows", async (t) => {
  const { first } = await fixture(t);
  await first.query("ALTER TABLE relations DROP COLUMN twin_kind");
  await first.query("ALTER TABLE relations DROP CONSTRAINT relations_type_check");
  await first.query("ALTER TABLE relations ADD CONSTRAINT relations_type_check CHECK (type IN ('parent','spouse','adoptive_parent','step_parent','godparent','nurse','sworn_sibling','guardian'))");
  await first.query(readFileSync(new URL("../../ops/postgres/044_family_link_types.sql", import.meta.url), "utf8"));
  assert.equal((await first.query("SELECT count(*)::int AS n FROM relations WHERE archive_id=$1", ["tree-a"])).rows[0].n, 1);
  await first.query(
    "INSERT INTO relations(archive_id,id,ordinal,source,target,type,twin_kind) VALUES($1,$2,$3,$4,$5,$6,$7)",
    ["tree-a", "new-twin", 2, "child", "own", "twin", "fraternal"],
  );
  assert.equal((await first.query("SELECT twin_kind FROM relations WHERE archive_id=$1 AND id=$2", ["tree-a", "new-twin"])).rows[0].twin_kind, "fraternal");
});

test("PostgreSQL migration 060 adds empty sources to legacy relations without changing links", async (t) => {
  const { first } = await fixture(t);
  await first.query("ALTER TABLE relations DROP COLUMN sources");
  const before = (await first.query("SELECT id,source,target,type FROM relations WHERE archive_id=$1 ORDER BY id", ["tree-a"])).rows;
  const migration = readFileSync(new URL("../../ops/postgres/060_family_link_sources.sql", import.meta.url), "utf8");
  await first.query(migration);
  await first.query(migration);
  const rows = (await first.query("SELECT id,source,target,type,sources FROM relations WHERE archive_id=$1 ORDER BY id", ["tree-a"])).rows;
  assert.deepEqual(rows.map((row) => ({ id: row.id, source: row.source,
    target: row.target, type: row.type })), before);
  assert.ok(rows.every((row) => Array.isArray(row.sources) && row.sources.length === 0));
});

test("adding another spouse preserves prior marriages and makes a retry idempotent", async (t) => {
  const { first } = await fixture(t);
  const before = (await read(first, "tree-a")).family;
  await graph(
    first,
    tokens.admin,
    "tree-a",
    archiveChanges(before, connectPeople(before, "child", "own", "spouse")),
    0,
  );
  const current = (await read(first, "tree-a")).family;
  const changes = archiveChanges(
    current,
    connectPeople(current, "father", "own", "spouse"),
  );
  const result = await graph(first, tokens.admin, "tree-a", changes, 1);
  const saved = (await read(first, "tree-a")).family;
  assert.deepEqual(
    applyArchiveChanges(current, result.appliedChanges).family,
    saved,
  );
  assert.deepEqual(saved.people.find((p) => p.id === "own")!.spouses, [
    "child",
    "father",
  ]);
  const state = await fingerprint(first);
  assert.deepEqual(
    (await graph(first, tokens.admin, "tree-a", changes, 1)).appliedChanges,
    [],
  );
  assert.deepEqual(await fingerprint(first), state);
});

test("one batch with several marriages returns and retries the exact stored graph", async (t) => {
  const { first } = await fixture(t);
  const before = (await read(first, "tree-a")).family;
  const people = [
    { ...draft("x"), spouses: ["z", "y"] },
    { ...draft("y"), spouses: ["x", "z"] },
    { ...draft("z"), spouses: ["y", "x"] },
  ];
  const changes = archiveChanges(before, {
    ...before,
    people: [...before.people, ...people],
  });
  const result = await graph(first, tokens.admin, "tree-a", changes, 0);
  assert.deepEqual(
    applyArchiveChanges(before, result.appliedChanges).family,
    (await read(first, "tree-a")).family,
  );
  const state = await fingerprint(first);
  assert.deepEqual(
    (await graph(first, tokens.admin, "tree-a", changes, 0)).appliedChanges,
    [],
  );
  assert.deepEqual(await fingerprint(first), state);
});

test("a tier downgrade committed while creation waits is applied before counting quota", async (t) => {
  const { first, second } = await fixture(t);
  await growTo(first, 150);
  const state = await fingerprint(first);
  await first.query("BEGIN");
  await first.query(
    "UPDATE account_tiers SET full_access=false WHERE account_id='admin'",
  );
  const result = assert.rejects(
    graph(second, tokens.relative, "tree-a", add("new"), 0),
    /150/,
  );
  await waitForLock(first, second);
  await first.query("COMMIT");
  await result;
  assert.deepEqual(await fingerprint(first), state);
});

test("two replacements of the same parent list yield a conflict instead of overwriting", async (t) => {
  const { first, second, third } = await fixture(t);
  const results = await Promise.allSettled([
    graph(
      second,
      tokens.admin,
      "tree-a",
      change("parents", [], ["father"], "own"),
      0,
    ),
    graph(
      third,
      tokens.relative,
      "tree-a",
      change("parents", [], ["child"], "own"),
      0,
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(
    (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason instanceof ConflictError,
  );
  assert.equal((await read(first, "tree-a")).revision, 1);
});
async function growTo(client: pg.Client, count: number, archiveId = "tree-a") {
  const rows = Array.from({ length: count - 3 }, (_, index) => ({
    id: `seed-${index}`,
    ordinal: index + 3,
    data: draft(`seed-${index}`),
  }));
  await client.query(
    `INSERT INTO people(archive_id,id,ordinal,data)
    SELECT $1,r.id,r.ordinal,r.data FROM jsonb_to_recordset($2::jsonb) r(id text,ordinal bigint,data jsonb)`,
    [archiveId, JSON.stringify(rows)],
  );
}

test("new people and parent/spouse relations commit together with the same family as SQLite", async (t) => {
  const { first } = await fixture(t);
  const sqlite = await openArchive(":memory:", family);
  t.after(async () => await sqlite.close());
  await first.query("UPDATE archives SET revision=1 WHERE id='tree-a'");
  const untouched = (
    await first.query(
      "SELECT id,xmin::text FROM people WHERE archive_id='tree-a' ORDER BY id",
    )
  ).rows;
  const other = await fingerprint(first, "tree-b");
  const before = (await read(first, "tree-a")).family;
  let after: Family = {
    ...structuredClone(before),
    people: [
      ...before.people,
      draft("mother", "1952"),
      {
        ...draft("baby", "1990"),
        sources: [
          {
            title: "Запись",
            type: "archive",
            reference: "Ф.6",
            url: "https://example.org",
            note: "Лист 2",
          },
        ],
      },
    ],
  };
  after = connectPeople(after, "father", "mother", "spouse");
  after = connectPeople(after, "father", "baby", "parent");
  after = connectPeople(after, "mother", "baby", "parent");
  const result = await graph(
    first,
    tokens.admin,
    "tree-a",
    archiveChanges(before, after),
    1,
  );
  for (const p of after.people)
    if (["mother", "baby"].includes(p.id)) p.createdBy = actor.id;
  await sqlite.write(after, 1, actor);
  assert.equal(result.revision, 2);
  assert.deepEqual(await read(first, "tree-a"), await sqlite.read());
  assert.deepEqual(
    (
      await first.query(
        "SELECT id,xmin::text FROM people WHERE archive_id='tree-a' AND id IN ('father','child','own') ORDER BY id",
      )
    ).rows,
    untouched,
  );
  assert.deepEqual(await fingerprint(first, "tree-b"), other);
  const history = (
    await first.query(
      "SELECT data FROM history WHERE archive_id='tree-a' AND revision=1",
    )
  ).rows[0].data;
  assert.deepEqual(history, before);
  const audit = (await postgresAuditReader(first, "tree-a").list()).items;
  assert.ok(audit.length >= 2);
  assert.ok(
    audit.every((entry) => entry.actorId === "admin" && entry.revision === 2),
  );
});

test("creation assigns its author on the server and a retry does not consume another place or revision", async (t) => {
  const { first } = await fixture(t);
  const changes = add("relative-child");
  const result = await graph(first, tokens.relative, "tree-a", changes, 0);
  const saved = (await read(first, "tree-a")).family.people.find(
    (p) => p.id === "relative-child",
  )!;
  assert.equal(saved.createdBy, "relative");
  assert.equal(
    (changes[0].after as { createdBy?: string }).createdBy,
    undefined,
    "caller input is not mutated",
  );
  const state = await fingerprint(first);
  assert.deepEqual(
    (await graph(first, tokens.relative, "tree-a", changes, 0)).appliedChanges,
    [],
  );
  assert.deepEqual(await fingerprint(first), state);
  await assert.rejects(
    graph(
      first,
      tokens.relative,
      "tree-a",
      add("relative-child", "2001"),
      result.revision,
    ),
    ConflictError,
  );
  assert.deepEqual(await fingerprint(first), state);
});

test("a new person cannot forge an author, attach a portrait or replace/delete an existing card", async (t) => {
  const { first } = await fixture(t);
  const state = await fingerprint(first);
  const link = { id: "edge", from: "child", to: "own", type: "guardian" };
  await assert.rejects(
    graph(
      first,
      tokens.admin,
      "tree-a",
      [
        {
          collection: "links",
          id: "edge",
          before: undefined,
          after: { ...link, unknown: "lost-on-save" },
        },
      ],
      0,
    ),
    /Неизвестное поле/,
  );
  await assert.rejects(
    graph(
      first,
      tokens.admin,
      "tree-a",
      [
        {
          collection: "links",
          id: "edge",
          before: undefined,
          after: { ...link, createdBy: "outsider" },
        },
      ],
      0,
    ),
    ForbiddenError,
  );
  for (const token of [tokens.admin, tokens.relative]) {
    await assert.rejects(
      graph(
        first,
        token,
        "tree-a",
        [
          {
            ...add("new")[0],
            after: { ...draft("new"), createdBy: "outsider" },
          },
        ],
        0,
      ),
      ForbiddenError,
    );
    await assert.rejects(
      graph(
        first,
        token,
        "tree-a",
        [
          {
            ...add("new")[0],
            after: { ...draft("new"), photo: "/media/secret.jpg" },
          },
        ],
        0,
      ),
      /без портрета/,
    );
  }
  await assert.rejects(
    graph(
      first,
      tokens.admin,
      "tree-a",
      [
        {
          collection: "people",
          id: "father",
          before: person("father", "1950"),
          after: undefined,
        },
      ],
      0,
    ),
    /добавление/,
  );
  for (const field of ["photo", "createdBy", "__proto__", "name"])
    await assert.rejects(
      graph(
        first,
        tokens.admin,
        "tree-a",
        change(field, undefined, "forged"),
        0,
      ),
      /только связи/,
    );
  assert.deepEqual(await fingerprint(first), state);
});

test("invalid last card rolls back the whole creation batch", async (t) => {
  const { first } = await fixture(t);
  const state = await fingerprint(first);
  await assert.rejects(
    graph(
      first,
      tokens.admin,
      "tree-a",
      [
        ...add("good"),
        { ...add("bad")[0], after: { ...draft("bad"), birth: "not-a-date" } },
      ],
      0,
    ),
    /карточка/,
  );
  assert.deepEqual(await fingerprint(first), state);
});

test("server rejects cycles, impossible parent dates, duplicates and a third biological parent", async (t) => {
  const { first } = await fixture(t);
  const state = await fingerprint(first);
  await assert.rejects(
    graph(
      first,
      tokens.admin,
      "tree-a",
      change("parents", [], ["child"], "father"),
      0,
    ),
    /раньше|цикл/,
  );
  await assert.rejects(
    graph(
      first,
      tokens.admin,
      "tree-a",
      change("parents", ["father"], ["own"], "child"),
      0,
    ),
    /раньше/,
  );
  await assert.rejects(
    graph(
      first,
      tokens.admin,
      "tree-a",
      change("parents", ["father"], ["father", "father"], "child"),
      0,
    ),
    /несколько раз/,
  );
  await assert.rejects(
    graph(
      first,
      tokens.admin,
      "tree-a",
      [
        ...add("mother", "1952"),
        ...add("third", "1953"),
        ...change(
          "parents",
          ["father"],
          ["father", "mother", "third"],
          "child",
        ),
      ],
      0,
    ),
    /двух кровных/,
  );
  assert.deepEqual(await fingerprint(first), state);
});

test("marriage must be symmetric and both spouses must be editable by the relative", async (t) => {
  const { first } = await fixture(t);
  const state = await fingerprint(first);
  await assert.rejects(
    graph(
      first,
      tokens.admin,
      "tree-a",
      change("spouses", [], ["own"], "father"),
      0,
    ),
    /обоих супругов/,
  );
  const before = (await read(first, "tree-a")).family;
  await assert.rejects(
    graph(
      first,
      tokens.relative,
      "tree-a",
      archiveChanges(before, connectPeople(before, "father", "own", "spouse")),
      0,
    ),
    ForbiddenError,
  );
  assert.deepEqual(await fingerprint(first), state);
  const married = connectPeople(before, "child", "own", "spouse");
  await graph(
    first,
    tokens.relative,
    "tree-a",
    archiveChanges(before, married),
    0,
  );
  assert.deepEqual((await read(first, "tree-a")).family, married);
});

test("relative can assign a visible parent to their own child but scoped access cannot link a hidden person", async (t) => {
  const { first } = await fixture(t);
  await graph(
    first,
    tokens.relative,
    "tree-a",
    change("parents", [], ["father"], "own"),
    0,
  );
  await graph(
    first,
    tokens.relative,
    "tree-a",
    change("parents", ["father"], [], "own"),
    1,
  );
  await first.query(
    "UPDATE archive_memberships SET tree_access='common_ancestors',person_id='own' WHERE archive_id='tree-a' AND user_id='relative'",
  );
  const state = await fingerprint(first);
  await assert.rejects(
    graph(
      first,
      tokens.relative,
      "tree-a",
      change("parents", [], ["father"], "own"),
      2,
    ),
    ForbiddenError,
  );
  assert.deepEqual(await fingerprint(first), state);
  await graph(first, tokens.relative, "tree-a", add("separate-branch"), 2);
  assert.equal(
    (await read(first, "tree-a")).family.people.at(-1)!.createdBy,
    "relative",
  );
});

test("foreign archive IDs and a reader role do not allow graph writes", async (t) => {
  const { first } = await fixture(t);
  await graph(first, tokens.admin, "tree-b", add("foreign-person"), 0);
  const state = await fingerprint(first);
  for (const token of [tokens.reader, tokens.outsider, "bad"])
    await assert.rejects(
      graph(first, token, "tree-a", add("new"), 0),
      ForbiddenError,
    );
  await first.query(
    "UPDATE archive_memberships SET role='reader' WHERE archive_id='tree-a' AND user_id='admin'",
  );
  await assert.rejects(
    graph(first, tokens.admin, "tree-a", add("new"), 0),
    ForbiddenError,
  );
  await first.query(
    "UPDATE archive_memberships SET role='admin' WHERE archive_id='tree-a' AND user_id='admin'",
  );
  await assert.rejects(
    graph(
      first,
      tokens.admin,
      "tree-a",
      change("parents", [], ["foreign-person"], "own"),
      0,
    ),
    /неизвестная семейная связь/,
  );
  assert.deepEqual(await fingerprint(first), state);
});

test("extra relation author, endpoint and type changes persist atomically and can be undone", async (t) => {
  const { first } = await fixture(t);
  const before = (await read(first, "tree-a")).family;
  const added = connectPeople(before, "child", "own", "godparent", "Крёстный");
  await graph(
    first,
    tokens.relative,
    "tree-a",
    archiveChanges(before, added),
    0,
  );
  const current = (await read(first, "tree-a")).family;
  const edge = archiveConnections(current).find(
    (edge) => edge.type === "godparent",
  )!;
  assert.equal(edge.createdBy, "relative");
  const moved = replaceConnection(current, edge, {
    from: "own",
    to: "child",
    type: "guardian",
    note: "Уточнение",
  });
  const replacement = await graph(
    first,
    tokens.relative,
    "tree-a",
    archiveChanges(current, moved),
    1,
  );
  assert.deepEqual((await read(first, "tree-a")).family, moved);
  await patch(
    first,
    tokens.relative,
    "tree-a",
    change("biography", undefined, "Не терять", "own"),
    2,
  );
  await graph(
    first,
    tokens.relative,
    "tree-a",
    inverseChanges(replacement.appliedChanges),
    2,
  );
  const restored = (await read(first, "tree-a")).family;
  assert.deepEqual(restored.links, current.links);
  assert.equal(
    restored.people.find((p) => p.id === "own")!.biography,
    "Не терять",
  );
  const clearNote: Change[] = [
    {
      collection: "links",
      id: edge.id!,
      field: "note",
      before: "Крёстный",
      after: "",
    },
  ];
  await graph(first, tokens.relative, "tree-a", clearNote, 4);
  assert.deepEqual(
    (await graph(first, tokens.relative, "tree-a", clearNote, 4))
      .appliedChanges,
    [],
  );
  const cleared = (await read(first, "tree-a")).family;
  assert.equal(cleared.links![0].note, undefined);
  const deletion = archiveChanges(cleared, removeConnection(cleared, edge));
  await graph(first, tokens.relative, "tree-a", deletion, 5);
  const state = await fingerprint(first);
  assert.deepEqual(
    (await graph(first, tokens.relative, "tree-a", deletion, 5)).appliedChanges,
    [],
  );
  assert.deepEqual(await fingerprint(first), state);
});

test("relation endpoint swaps and parent reordering do not collide with UNIQUE constraints", async (t) => {
  const { first } = await fixture(t);
  const before = (await read(first, "tree-a")).family;
  const added = connectPeople(
    connectPeople(before, "father", "child", "godparent"),
    "child",
    "own",
    "godparent",
  );
  await graph(first, tokens.admin, "tree-a", archiveChanges(before, added), 0);
  const current = (await read(first, "tree-a")).family;
  const swapped = structuredClone(current);
  [swapped.links![0].from, swapped.links![1].from] = [
    swapped.links![1].from,
    swapped.links![0].from,
  ];
  [swapped.links![0].to, swapped.links![1].to] = [
    swapped.links![1].to,
    swapped.links![0].to,
  ];
  await graph(
    first,
    tokens.admin,
    "tree-a",
    archiveChanges(current, swapped),
    1,
  );
  assert.deepEqual((await read(first, "tree-a")).family, swapped);
  await graph(
    first,
    tokens.admin,
    "tree-a",
    [
      ...add("mother", "1951"),
      ...change("parents", ["father"], ["mother", "father"], "child"),
    ],
    2,
  );
  assert.deepEqual(
    (await read(first, "tree-a")).family.people.find((p) => p.id === "child")!
      .parents,
    ["mother", "father"],
  );
});

test("concurrent relations that would jointly form a cycle cannot both commit", async (t) => {
  const { first, second, third } = await fixture(t);
  await graph(
    first,
    tokens.relative,
    "tree-a",
    [...add("x", ""), ...add("y", "")],
    0,
  );
  await first.query("BEGIN");
  await first.query(
    "SELECT revision FROM archives WHERE id='tree-a' FOR UPDATE",
  );
  const results = Promise.allSettled([
    graph(second, tokens.admin, "tree-a", change("parents", [], ["y"], "x"), 1),
    graph(
      third,
      tokens.relative,
      "tree-a",
      change("parents", [], ["x"], "y"),
      1,
    ),
  ]);
  await waitForLock(first, second);
  await waitForLock(first, third);
  await first.query("COMMIT");
  const settled = await results;
  assert.equal(
    settled.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.match(
    String(
      (
        settled.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ),
    /цикл/,
  );
  assert.equal((await read(first, "tree-a")).revision, 2);
});

test("graph creation and a concurrent person field patch preserve both changes", async (t) => {
  const { first, second, third } = await fixture(t);
  await first.query("BEGIN");
  await first.query(
    "SELECT revision FROM archives WHERE id='tree-a' FOR UPDATE",
  );
  const results = Promise.allSettled([
    patch(second, tokens.admin, "tree-a", change("birth", "1950", "1951"), 0),
    graph(
      third,
      tokens.relative,
      "tree-a",
      [{ ...add("new")[0], after: { ...draft("new"), parents: ["father"] } }],
      0,
    ),
  ]);
  await waitForLock(first, second);
  await waitForLock(first, third);
  await first.query("COMMIT");
  assert.ok((await results).every((result) => result.status === "fulfilled"));
  const saved = await read(first, "tree-a");
  assert.equal(saved.revision, 2);
  assert.equal(saved.family.people[0].birth, "1951");
  assert.deepEqual(saved.family.people.at(-1)!.parents, ["father"]);
});

test("two concurrent retries with one person ID create one card and one audit event", async (t) => {
  const { first, second, third } = await fixture(t);
  const results = await Promise.all([
    graph(second, tokens.relative, "tree-a", add("same"), 0),
    graph(third, tokens.relative, "tree-a", add("same"), 0),
  ]);
  assert.ok(results.every((result) => result.revision === 1));
  assert.equal(
    results.filter((result) => result.appliedChanges.length > 0).length,
    1,
  );
  assert.equal((await read(first, "tree-a")).family.people.length, 4);
  assert.equal(
    (await postgresAuditReader(first, "tree-a").list()).items.length,
    1,
  );
});

for (const fullAccess of [false, true])
  test(`two editors at 149 people respect the owner's ${fullAccess ? "full" : "basic"} tier`, async (t) => {
    const { first, second, third } = await fixture(t);
    await growTo(first, 149);
    await first.query(
      "UPDATE account_tiers SET full_access=$1 WHERE account_id='admin'",
      [fullAccess],
    );
    const results = await Promise.allSettled([
      graph(second, tokens.admin, "tree-a", add("a"), 0),
      graph(third, tokens.relative, "tree-a", add("b"), 0),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      fullAccess ? 2 : 1,
    );
    if (!fullAccess)
      assert.match(
        String(
          (
            results.find(
              (result) => result.status === "rejected",
            ) as PromiseRejectedResult
          ).reason,
        ),
        /150/,
      );
    assert.equal(
      (await read(first, "tree-a")).family.people.length,
      fullAccess ? 151 : 150,
    );
    assert.equal(
      (await postgresAuditReader(first, "tree-a").list()).items.length,
      fullAccess ? 2 : 1,
    );
  });

test("batch creation cannot partially fill the last quota slot, but relation edits still work above quota", async (t) => {
  const { first } = await fixture(t);
  await growTo(first, 149);
  await first.query(
    "UPDATE account_tiers SET full_access=false WHERE account_id='admin'",
  );
  const before = await fingerprint(first);
  await assert.rejects(
    graph(first, tokens.relative, "tree-a", [...add("a"), ...add("b")], 0),
    /150/,
  );
  assert.deepEqual(await fingerprint(first), before);
  await graph(first, tokens.relative, "tree-a", add("last"), 0);
  await graph(
    first,
    tokens.relative,
    "tree-a",
    change("parents", [], ["father"], "own"),
    1,
  );
  assert.equal((await read(first, "tree-a")).revision, 2);
});

test("downgrading an over-quota tree preserves reading and relation edits while blocking growth", async (t) => {
  const { first } = await fixture(t);
  await growTo(first, 151);
  await first.query(
    "UPDATE account_tiers SET full_access=false WHERE account_id='admin'",
  );
  assert.equal((await read(first, "tree-a")).family.people.length, 151);
  await graph(
    first,
    tokens.relative,
    "tree-a",
    change("parents", [], ["father"], "own"),
    0,
  );
  await assert.rejects(
    graph(first, tokens.relative, "tree-a", add("beyond-limit"), 1),
    /150/,
  );
  assert.equal((await read(first, "tree-a")).family.people.length, 151);
});

test("creation fails closed without owner/tier, full access still keeps the technical graph limit", async (t) => {
  const { first } = await fixture(t);
  await first.query("DELETE FROM archive_owners WHERE archive_id='tree-a'");
  await assert.rejects(
    graph(first, tokens.admin, "tree-a", add("new"), 0),
    /владелец/,
  );
  await first.query(
    "INSERT INTO archive_owners(archive_id,user_id) VALUES('tree-a','admin')",
  );
  await first.query("DELETE FROM account_tiers WHERE account_id='admin'");
  await assert.rejects(
    graph(first, tokens.admin, "tree-a", add("new"), 0),
    /уровень/,
  );
  await first.query(
    "INSERT INTO account_tiers(account_id,full_access) VALUES('admin',true)",
  );
  await growTo(first, 10_000);
  await assert.rejects(
    graph(first, tokens.admin, "tree-a", add("too-many"), 0),
    /данных о людях/,
  );
  assert.equal((await read(first, "tree-a")).family.people.length, 10_000);
  assert.equal((await read(first, "tree-a")).revision, 0);
});

test("revoked membership while a graph write waits prevents creating any rows", async (t) => {
  const { first, second } = await fixture(t);
  const state = await fingerprint(first);
  await first.query("BEGIN");
  await first.query(
    "SELECT revision FROM archives WHERE id='tree-a' FOR UPDATE",
  );
  const result = assert.rejects(
    graph(second, tokens.relative, "tree-a", add("new"), 0),
    ForbiddenError,
  );
  await waitForLock(first, second);
  await first.query(
    "UPDATE archive_memberships SET approved=false WHERE archive_id='tree-a' AND user_id='relative'",
  );
  await first.query("COMMIT");
  await result;
  assert.deepEqual(await fingerprint(first), state);
});

test("audit failure rolls back new people, relations, revision and history", async (t) => {
  const { first } = await fixture(t);
  const state = await fingerprint(first);
  await first.query(`CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
    CREATE TRIGGER reject_audit BEFORE INSERT ON archive_audit_entries FOR EACH ROW EXECUTE FUNCTION reject_audit()`);
  await assert.rejects(
    graph(
      first,
      tokens.admin,
      "tree-a",
      [{ ...add("new")[0], after: { ...draft("new"), parents: ["father"] } }],
      0,
    ),
    /audit unavailable/,
  );
  assert.deepEqual(await fingerprint(first), state);
  await first.query("DROP TRIGGER reject_audit ON archive_audit_entries");
  await graph(first, tokens.admin, "tree-a", add("new"), 0);
  assert.equal((await read(first, "tree-a")).revision, 1);
});
