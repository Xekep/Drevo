import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  archiveChanges,
  applyArchiveChanges,
} from "../../src/domain/changes.ts";
import { removePerson, connectPeople } from "../../src/domain/mutations.ts";
import {
  removePostgresPersonForSession as remove,
  restorePostgresPersonForSession as restore,
} from "../../src/server/postgres-person-removal.ts";
import { changePostgresGraphForSession as graph } from "../../src/server/postgres-graph-changes.ts";
import { patchPostgresPeopleForSession as patch } from "../../src/server/postgres-person-patches.ts";
import { readPostgresArchive as read } from "../../src/server/postgres-archive-read.ts";
import { ForbiddenError } from "../../src/server/users.ts";
import { ConflictError } from "../../src/server/archive-errors.ts";
import {
  fixture,
  fingerprint,
  tokens,
  change,
  person,
  waitForLock,
} from "./postgres-fixture.ts";

async function dependencies(client: pg.Client) {
  await client.query(`INSERT INTO documents(archive_id,id,ordinal,title,title_search,file_name,file_size,uploaded_by,created_at)
    VALUES('tree-a','doc',0,'Свидетельство','свидетельство','original.pdf',100,'admin','2026-01-01')`);
  await client.query(
    "INSERT INTO document_people VALUES('tree-a',0,'doc','child'),('tree-a',1,'doc','father')",
  );
  await client.query(
    "INSERT INTO person_comments(archive_id,id,person_id,author_id,created_ms,text) VALUES('tree-a',42,'child','relative',123456,'Обсуждение'),('tree-a',43,'father','admin',123457,'Другая запись')",
  );
  await client.query(`UPDATE people SET data=data || '{"photo":"/media/portrait.png","sources":[{"title":"Источник","type":"document","reference":"Ф.1","url":"https://example.org","note":"Комментарий"}]}'::jsonb
    WHERE archive_id='tree-a' AND id='child'`);
}

test("person deletion/undo preserves graph, authors, photos, documents and discussion without touching another archive", async (t) => {
  const { first } = await fixture(t);
  await dependencies(first);
  let before = (await read(first, "tree-a")).family;
  const linked = connectPeople(
    connectPeople(before, "child", "own", "spouse"),
    "child",
    "own",
    "godparent",
    "Крёстный",
  );
  await graph(first, tokens.admin, "tree-a", archiveChanges(before, linked), 0);
  before = (await read(first, "tree-a")).family;
  const other = await fingerprint(first, "tree-b");
  const request = randomUUID();
  const deleted = await remove(
    first,
    tokens.admin,
    "tree-a",
    "child",
    request,
    1,
  );
  const after = (await read(first, "tree-a")).family;
  assert.deepEqual(after, removePerson(before, "child"));
  assert.deepEqual(
    applyArchiveChanges(before, deleted.appliedChanges).family,
    after,
  );
  assert.equal(
    (
      await first.query(
        "SELECT count(*) FROM person_comments WHERE archive_id='tree-a'",
      )
    ).rows[0].count,
    "1",
  );
  assert.equal(
    (
      await first.query(
        "SELECT count(*) FROM document_people WHERE archive_id='tree-a'",
      )
    ).rows[0].count,
    "1",
  );
  const doc = (
    await first.query("SELECT * FROM documents WHERE archive_id='tree-a'")
  ).rows;
  const state = await fingerprint(first);
  assert.deepEqual(
    (await remove(first, tokens.admin, "tree-a", "child", request, 1))
      .appliedChanges,
    [],
  );
  assert.deepEqual(await fingerprint(first), state);
  const undone = await restore(first, tokens.admin, "tree-a", request, 2);
  const saved = (await read(first, "tree-a")).family;
  assert.deepEqual(
    applyArchiveChanges(after, undone.appliedChanges).family,
    saved,
  );
  assert.deepEqual(
    [...saved.people].sort((a, b) => a.id.localeCompare(b.id)),
    [...before.people].sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.deepEqual(saved.photos, before.photos);
  assert.deepEqual(saved.links, before.links);
  assert.deepEqual(
    (await first.query("SELECT * FROM documents WHERE archive_id='tree-a'"))
      .rows,
    doc,
  );
  assert.equal(
    (
      await first.query(
        "SELECT count(*) FROM document_people WHERE archive_id='tree-a'",
      )
    ).rows[0].count,
    "2",
  );
  assert.deepEqual(
    (
      await first.query(
        "SELECT author_id,created_ms,text FROM person_comments WHERE archive_id='tree-a' AND id=42",
      )
    ).rows[0],
    { author_id: "relative", created_ms: "123456", text: "Обсуждение" },
  );
  assert.deepEqual(await fingerprint(first, "tree-b"), other);
  const restored = await fingerprint(first);
  assert.deepEqual(
    (await restore(first, tokens.admin, "tree-a", request, 2)).appliedChanges,
    [],
  );
  assert.equal(
    (await remove(first, tokens.admin, "tree-a", "child", request, 1)).status,
    "restored",
  );
  assert.deepEqual(await fingerprint(first), restored);
  const audit = (
    await first.query(
      "SELECT action FROM archive_audit_entries WHERE archive_id='tree-a' AND entity_id='child' ORDER BY id",
    )
  ).rows;
  assert.ok(audit.some((row) => row.action === "Удалено"));
  assert.ok(audit.some((row) => row.action === "Добавлено"));
});

test("deletion is admin-only, archive-scoped and validates request IDs", async (t) => {
  const { first } = await fixture(t);
  const state = await fingerprint(first);
  for (const token of [
    tokens.relative,
    tokens.reader,
    tokens.outsider,
    "invalid",
  ])
    await assert.rejects(
      remove(first, token, "tree-a", "child", randomUUID(), 0),
      ForbiddenError,
    );
  await assert.rejects(
    remove(first, tokens.admin, "missing", "child", randomUUID(), 0),
    ForbiddenError,
  );
  await assert.rejects(
    remove(first, tokens.admin, "tree-a", "missing", randomUUID(), 0),
    ConflictError,
  );
  await assert.rejects(
    remove(first, tokens.admin, "tree-a", "child", "bad", 0),
    /идентификатор/,
  );
  assert.deepEqual(await fingerprint(first), state);
});

test("linked accounts must be explicitly unbound; failed deletion leaves scoped access unchanged", async (t) => {
  const { first } = await fixture(t);
  await first.query(
    "UPDATE archive_memberships SET person_id='child',tree_access='common_ancestors' WHERE archive_id='tree-a' AND user_id='relative'",
  );
  const state = await fingerprint(first);
  await assert.rejects(
    remove(first, tokens.admin, "tree-a", "child", randomUUID(), 0),
    /привязку аккаунта/,
  );
  assert.deepEqual(await fingerprint(first), state);
  assert.deepEqual(
    (
      await first.query(
        "SELECT person_id,tree_access FROM archive_memberships WHERE archive_id='tree-a' AND user_id='relative'",
      )
    ).rows[0],
    { person_id: "child", tree_access: "common_ancestors" },
  );
});

test("stale deletion refuses new dependencies and never overwrites a concurrently edited person", async (t) => {
  const { first } = await fixture(t);
  await patch(
    first,
    tokens.relative,
    "tree-a",
    change("biography", undefined, "Новая запись", "child"),
    0,
  );
  const state = await fingerprint(first);
  await assert.rejects(
    remove(first, tokens.admin, "tree-a", "child", randomUUID(), 0),
    ConflictError,
  );
  assert.deepEqual(await fingerprint(first), state);
});

test("undo preserves independent edits but conflicts on changed child parents", async (t) => {
  const { first } = await fixture(t);
  const id = randomUUID();
  await remove(first, tokens.admin, "tree-a", "father", id, 0);
  await patch(
    first,
    tokens.relative,
    "tree-a",
    change("biography", undefined, "Не потерять", "child"),
    1,
  );
  await restore(first, tokens.admin, "tree-a", id, 1);
  const child = (await read(first, "tree-a")).family.people.find(
    (p) => p.id === "child",
  )!;
  assert.equal(child.biography, "Не потерять");
  assert.deepEqual(child.parents, ["father"]);
  const second = randomUUID();
  await remove(first, tokens.admin, "tree-a", "father", second, 3);
  const p = { ...person("mother", "1950"), createdBy: "admin" };
  await graph(
    first,
    tokens.admin,
    "tree-a",
    [
      { collection: "people", id: p.id, before: undefined, after: p },
      ...change("parents", [], [p.id], "child"),
    ],
    4,
  );
  const state = await fingerprint(first);
  await assert.rejects(
    restore(first, tokens.admin, "tree-a", second, 4),
    ConflictError,
  );
  assert.deepEqual(await fingerprint(first), state);
});

test("undo cannot overwrite a reused person ID or resurrect a later deletion on retry", async (t) => {
  const { first } = await fixture(t);
  const id = randomUUID();
  await remove(first, tokens.admin, "tree-a", "own", id, 0);
  const reused = { ...person("own", "2001"), createdBy: "admin" };
  await graph(
    first,
    tokens.admin,
    "tree-a",
    [{ collection: "people", id: "own", before: undefined, after: reused }],
    1,
  );
  const state = await fingerprint(first);
  await assert.rejects(
    restore(first, tokens.admin, "tree-a", id, 1),
    ConflictError,
  );
  assert.deepEqual(await fingerprint(first), state);
  const next = randomUUID();
  await remove(first, tokens.admin, "tree-a", "own", next, 2);
  await restore(first, tokens.admin, "tree-a", next, 3);
  await remove(first, tokens.admin, "tree-a", "own", randomUUID(), 4);
  assert.deepEqual(
    (await restore(first, tokens.admin, "tree-a", next, 4)).appliedChanges,
    [],
  );
  assert.ok(
    !(await read(first, "tree-a")).family.people.some((p) => p.id === "own"),
  );
});

test("undo receipt belongs to its actor and archive, even for another administrator", async (t) => {
  const { first } = await fixture(t);
  const id = randomUUID();
  await remove(first, tokens.admin, "tree-a", "child", id, 0);
  await first.query(
    "UPDATE archive_memberships SET role='admin' WHERE archive_id='tree-a' AND user_id='relative'",
  );
  const state = await fingerprint(first);
  await assert.rejects(
    restore(first, tokens.relative, "tree-a", id, 1),
    ForbiddenError,
  );
  await assert.rejects(
    restore(first, tokens.admin, "tree-b", id, 0),
    ForbiddenError,
  );
  await assert.rejects(
    remove(first, tokens.admin, "tree-a", "father", id, 0),
    ConflictError,
  );
  assert.deepEqual(await fingerprint(first), state);
});

for (const scenario of ["document", "comment", "photo", "tags"] as const)
  test(`undo rolls back completely when ${scenario} changed or its ID was reused`, async (t) => {
    const { first } = await fixture(t);
    await dependencies(first);
    const id = randomUUID();
    await remove(first, tokens.admin, "tree-a", "child", id, 0);
    if (scenario === "document")
      await first.query(
        "UPDATE documents SET file_name='replacement.pdf' WHERE archive_id='tree-a'",
      );
    if (scenario === "comment")
      await first.query(
        "INSERT INTO person_comments(archive_id,id,person_id,author_id,created_ms,text) VALUES('tree-a',42,'father','admin',999,'Не перезаписывать')",
      );
    if (scenario === "photo")
      await first.query(
        `UPDATE photos SET data=jsonb_set(data,'{url}','"/media/other.png"') WHERE archive_id='tree-a'`,
      );
    if (scenario === "tags")
      await first.query(
        `INSERT INTO photo_tags VALUES('tree-a','photo:tag',1,'photo','father','{"id":"tag","personId":"father","x":0,"y":0,"width":1,"height":1}')`,
      );
    const state = await fingerprint(first);
    await assert.rejects(
      restore(first, tokens.admin, "tree-a", id, 1),
      ConflictError,
    );
    assert.deepEqual(await fingerprint(first), state);
  });

test("parallel delete retries produce one receipt, one revision, and preserve CAS against a late edit", async (t) => {
  const { first, second, third } = await fixture(t);
  const id = randomUUID();
  const results = await Promise.all([
    remove(first, tokens.admin, "tree-a", "child", id, 0),
    remove(second, tokens.admin, "tree-a", "child", id, 0),
  ]);
  assert.equal(results.filter((r) => r.appliedChanges.length > 0).length, 1);
  assert.equal((await read(third, "tree-a")).revision, 1);
  await assert.rejects(
    patch(
      third,
      tokens.relative,
      "tree-a",
      change("biography", undefined, "Поздно", "child"),
      0,
    ),
  );
  const restored = await Promise.all([
    restore(first, tokens.admin, "tree-a", id, 1),
    restore(second, tokens.admin, "tree-a", id, 1),
  ]);
  assert.equal(restored.filter((r) => r.appliedChanges.length > 0).length, 1);
  assert.equal((await read(third, "tree-a")).revision, 2);
});

test("role revocation while deletion is queued prevents the cascade", async (t) => {
  const { first, second, third } = await fixture(t);
  await first.query("BEGIN");
  await first.query("SELECT id FROM archives WHERE id='tree-a' FOR UPDATE");
  const pending = assert.rejects(
    remove(second, tokens.admin, "tree-a", "child", randomUUID(), 0),
    ForbiddenError,
  );
  await waitForLock(third, second);
  await first.query(
    "UPDATE archive_memberships SET role='reader' WHERE archive_id='tree-a' AND user_id='admin'",
  );
  await first.query("COMMIT");
  await pending;
  assert.equal((await read(first, "tree-a")).family.people.length, 3);
  assert.equal(
    (await first.query("SELECT count(*) FROM person_removals")).rows[0].count,
    "0",
  );
});

test("audit failure rolls back deletion, cascades, history and receipt together", async (t) => {
  const { first } = await fixture(t);
  await dependencies(first);
  await first.query(
    "ALTER TABLE archive_audit_entries ADD CONSTRAINT reject_deletion CHECK(action <> 'Удалено')",
  );
  const state = await fingerprint(first);
  await assert.rejects(
    remove(first, tokens.admin, "tree-a", "child", randomUUID(), 0),
  );
  assert.deepEqual(await fingerprint(first), state);
});

test("undo enforces the owner's people quota; freeing space then permits retry", async (t) => {
  const { first } = await fixture(t);
  const id = randomUUID();
  await remove(first, tokens.admin, "tree-a", "own", id, 0);
  await first.query(
    "UPDATE account_tiers SET full_access=false WHERE account_id='admin'",
  );
  const additions = Array.from({ length: 148 }, (_, i) => ({
    ...person(`new-${i}`, "2000"),
    createdBy: "admin",
  }));
  await graph(
    first,
    tokens.admin,
    "tree-a",
    additions.map((p) => ({
      collection: "people",
      id: p.id,
      before: undefined,
      after: p,
    })),
    1,
  );
  const state = await fingerprint(first);
  await assert.rejects(restore(first, tokens.admin, "tree-a", id, 1), /150/);
  assert.deepEqual(await fingerprint(first), state);
  await remove(first, tokens.admin, "tree-a", "new-0", randomUUID(), 2);
  await restore(first, tokens.admin, "tree-a", id, 3);
  assert.equal((await read(first, "tree-a")).family.people.length, 150);
});

test("undo receipts expire with the 50-revision history window", async (t) => {
  const { first } = await fixture(t);
  const id = randomUUID();
  await remove(first, tokens.admin, "tree-a", "own", id, 0);
  let previous: string | undefined;
  for (let i = 1; i <= 50; i++) {
    await patch(
      first,
      tokens.admin,
      "tree-a",
      change("biography", previous, `${i}`),
      i,
    );
    previous = `${i}`;
  }
  assert.equal(
    (await first.query("SELECT count(*) FROM person_removals")).rows[0].count,
    "0",
  );
  await assert.rejects(
    restore(first, tokens.admin, "tree-a", id, 51),
    ForbiddenError,
  );
});

test("bulk restore retains other face tags, multiple documents and all discussion authors", async (t) => {
  const { first } = await fixture(t);
  await dependencies(first);
  await first.query(
    `INSERT INTO photo_tags VALUES('tree-a','photo:other',1,'photo','father','{"id":"other","personId":"father","x":0.1,"y":0.1,"width":0.2,"height":0.2}')`,
  );
  await first.query(
    `INSERT INTO documents SELECT archive_id,'doc2',1,title,title_search,'second.pdf',file_size,uploaded_by,created_at FROM documents WHERE archive_id='tree-a' AND id='doc'`,
  );
  await first.query(
    "INSERT INTO document_people VALUES('tree-a',2,'doc2','child')",
  );
  await first.query(
    "INSERT INTO person_comments(archive_id,id,person_id,author_id,created_ms,text) SELECT 'tree-a',i,'child','reader',123456,'Комментарий ' || i FROM generate_series(100,299) i",
  );
  const request = randomUUID();
  await remove(first, tokens.admin, "tree-a", "child", request, 0);
  const before = (await read(first, "tree-a")).family;
  const result = await restore(first, tokens.admin, "tree-a", request, 1);
  const after = (await read(first, "tree-a")).family;
  assert.deepEqual(
    applyArchiveChanges(before, result.appliedChanges).family,
    after,
  );
  assert.deepEqual(
    after.photos![0].tags.map((tag) => tag.id),
    ["other", "tag"],
  );
  assert.equal(
    (
      await first.query(
        "SELECT count(*) FROM person_comments WHERE archive_id='tree-a' AND author_id='reader'",
      )
    ).rows[0].count,
    "200",
  );
  assert.equal(
    (
      await first.query(
        "SELECT count(*) FROM document_people WHERE archive_id='tree-a' AND person_id='child'",
      )
    ).rows[0].count,
    "2",
  );
});

test("failure after dependency restoration rolls back the entire undo and allows retry", async (t) => {
  const { first } = await fixture(t);
  await dependencies(first);
  const request = randomUUID();
  await remove(first, tokens.admin, "tree-a", "child", request, 0);
  await first.query(
    "ALTER TABLE archive_audit_entries ADD CONSTRAINT reject_restore CHECK(action <> 'Добавлено')",
  );
  const state = await fingerprint(first);
  await assert.rejects(restore(first, tokens.admin, "tree-a", request, 1));
  assert.deepEqual(await fingerprint(first), state);
  await first.query(
    "ALTER TABLE archive_audit_entries DROP CONSTRAINT reject_restore",
  );
  assert.equal(
    (await restore(first, tokens.admin, "tree-a", request, 1)).status,
    "restored",
  );
});
