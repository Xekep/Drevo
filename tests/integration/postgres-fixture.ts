import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { Family, Person } from "../../src/domain/types.ts";
import type { Change } from "../../src/domain/changes.ts";
import { archiveRows } from "../../src/server/archive-rows.ts";
import { sessionTokenHash } from "../../src/server/session-token.ts";
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

export const tokens = {
  admin: "a".repeat(64),
  relative: "b".repeat(64),
  reader: "c".repeat(64),
  outsider: "d".repeat(64),
};
export const actor = {
  id: "admin",
  name: "Администратор",
  role: "admin" as const,
  approved: true,
  createdAt: "2026-01-01",
};
export const person = (
  id: string,
  birth: string,
  parents: string[] = [],
): Person => ({
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
export const family: Family = {
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
export const change = (
  field: string,
  before: unknown,
  after: unknown,
  id = "father",
): Change[] => [{ collection: "people", id, field, before, after }];

export async function fixture(t: TestContext) {
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
    "005_archive_owner_uniqueness.sql",
    "008_account_tiers.sql",
    "009_person_removals.sql",
  ])
    await first.query(
      readFileSync(
        new URL(`../../ops/postgres/${file}`, import.meta.url),
        "utf8",
      ),
    );
  // This focused fixture omits share and research tables. Install the audit
  // portion of migration 041 so its read path uses the production view.
  await first.query(
    readFileSync(
      new URL("../../ops/postgres/041_deleted_account_history.sql", import.meta.url),
      "utf8",
    ).split("CREATE OR REPLACE VIEW runtime_visible_person_comments")[0],
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
  await first.query(
    "INSERT INTO account_tiers(account_id,full_access) SELECT id,true FROM accounts",
  );
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
        "INSERT INTO relations(archive_id,id,ordinal,source,target,type,note,twin_kind,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [archiveId, row.id, index, row.source, row.target, row.type, row.note, row.twinKind, row.createdBy],
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
  await first.query(
    "INSERT INTO archive_owners(archive_id,user_id) VALUES('tree-a','admin'),('tree-b','relative')",
  );
  return { first, second: clients[1], third: clients[2] };
}

export async function fingerprint(client: pg.Client, archiveId = "tree-a") {
  const tables = [
    "archives",
    "people",
    "relations",
    "photos",
    "photo_tags",
    "history",
    "archive_audit_entries",
    "archive_audit_people",
    "person_removals",
    "documents",
    "document_people",
    "person_comments",
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

export async function waitForLock(observer: pg.Client, blocked: pg.Client) {
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
