import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fixture } from "./postgres-fixture.ts";
import {
  postgresBindings,
  type StoreDatabase,
} from "../../src/server/store-database.ts";
import { mediaReferenceAccess } from "../../src/server/media-reference-access.ts";
import { readPostgresArchive } from "../../src/server/postgres-archive-read.ts";
import { visiblePersonIds } from "../../src/domain/tree-access.ts";
import type { ArchiveUser } from "../../src/domain/access.ts";
import type { openArchive } from "../../src/server/database.ts";

const migration = (file: string) =>
  readFileSync(new URL(`../../ops/postgres/${file}`, import.meta.url), "utf8");

test("native104 indexes direct portrait/gallery references under FORCE RLS without changing scoped access", async (t) => {
  const cleanup: Array<() => Promise<void>> = [];
  const role = `media_lookup_${randomUUID().replaceAll("-", "")}`;
  const resources: { clients?: Awaited<ReturnType<typeof fixture>> } = {};
  let roleCreated = false;
  t.after(async () => {
    const clients = resources.clients;
    try {
      if (clients) {
        for (const client of Object.values(clients)) {
          await client.query("ROLLBACK");
          await client.query("RESET ROLE");
        }
        if (roleCreated) {
          await clients.first.query(`DROP OWNED BY ${role} CASCADE`);
          await clients.first.query(`DROP ROLE ${role}`);
        }
      }
    } finally {
      for (const close of cleanup) await close();
    }
  });
  const clients = (resources.clients = await fixture({
    after(close: () => Promise<void>) {
      cleanup.push(close);
    },
  } as unknown as Parameters<typeof fixture>[0]));
  const { first } = clients;
  const schema = String(
    (await first.query("SELECT current_schema() AS schema")).rows[0].schema,
  );
  await first.query(migration("048_source_catalog.sql"));
  const runtime = migration("010_runtime_services.sql");
  for (const table of ["people", "photos", "photo_tags"]) {
    const policy = runtime.match(
      new RegExp(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;[\\s\\S]*?CREATE POLICY archive_scope ON ${table}[\\s\\S]*?;`,
      ),
    );
    assert.ok(policy);
    await first.query(policy[0]);
  }
  await first.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  await first.query(`INSERT INTO people(archive_id,id,ordinal,data)
    SELECT 'tree-a','lookup-person-'||n,n+100,jsonb_build_object('id','lookup-person-'||n,'name','Synthetic',
      'parents','[]'::jsonb,'spouses','[]'::jsonb,'sources','[]'::jsonb,'createdBy','admin','biography',repeat('Synthetic ',100))
    FROM generate_series(1,10000) n`);
  await first.query(`INSERT INTO photos(archive_id,id,ordinal,data)
    SELECT 'tree-a','lookup-photo-'||n,n+100,jsonb_build_object('id','lookup-photo-'||n,'url','/media/filler-'||n||'.png','createdBy','admin')
    FROM generate_series(1,10000) n`);
  await first.query(
    `UPDATE people SET data=jsonb_set(data,'{photo}','"/media/child-portrait.png"') WHERE archive_id='tree-a' AND id='child'`,
  );
  await first.query(
    `UPDATE photos SET data=jsonb_set(data,'{url}','"/media/visible-gallery.png"') WHERE archive_id='tree-a' AND id='photo'`,
  );
  await first.query("SELECT set_config('drevo.archive_id','tree-b',false)");
  await first.query(
    `UPDATE photos SET data=jsonb_set(data,'{url}','"/media/foreign-gallery.png"') WHERE archive_id='tree-b' AND id='photo'`,
  );
  await first.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  roleCreated = true;
  await first.query(`GRANT USAGE,CREATE ON SCHEMA ${schema} TO ${role}`);
  await first.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
  );
  for (const table of ["people", "photos"])
    await first.query(`ALTER TABLE ${table} OWNER TO ${role}`);
  await first.query(`SET ROLE ${role}`);
  await first.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  assert.deepEqual(
    (
      await first.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0],
    { rolsuper: false, rolbypassrls: false },
  );
  await first.query(migration("104_media_url_lookup.sql"));
  await first.query("ANALYZE people,photos");
  const direct: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    kind: "postgres",
    archiveId: "tree-a",
    prepare(_sqlite: string, postgres: string) {
      const sql = postgresBindings(postgres);
      return {
        get: async (...values: unknown[]) => {
          if (sql.includes("portrait_url=q.url")) direct.push({ sql, values });
          return (await first.query(sql, values)).rows[0];
        },
      };
    },
  } as unknown as StoreDatabase;
  const archive = {
    db,
    visibleIds: async (user: ArchiveUser) =>
      visiblePersonIds(
        (await readPostgresArchive(first, "tree-a")).family,
        user,
      ),
  } as unknown as Awaited<ReturnType<typeof openArchive>>;
  const access = mediaReferenceAccess(archive);
  const owner: ArchiveUser = {
    id: "admin",
    name: "Owner",
    role: "admin",
    approved: true,
    createdAt: "",
    treeAccess: "all",
  };
  const scoped: ArchiveUser = {
    id: "relative",
    name: "Relative",
    role: "relative",
    approved: true,
    createdAt: "",
    treeAccess: "common_ancestors",
    personId: "child",
  };
  for (const [kind, url, allowed] of [
    ["portrait", "/media/child-portrait.png", true],
    ["gallery", "/media/visible-gallery.png", true],
    ["negative", "/media/absent-portrait.png", false],
  ] as const) {
    assert.equal(await access(url, owner), allowed);
    const query = direct.at(-1)!;
    const plan = (
      await first.query(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`,
        query.values,
      )
    ).rows[0]["QUERY PLAN"][0];
    const nodes: Array<Record<string, unknown>> = [];
    const walk = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans || []) as Array<Record<string, unknown>>)
        walk(child);
    };
    walk(plan.Plan);
    assert.ok(
      nodes.every((node) => Number(node["Rows Removed by Filter"] || 0) < 32),
      `${kind}: direct URL lookup must not scan 10000 cards`,
    );
    assert.ok(
      Number(plan.Plan["Shared Hit Blocks"]) < 32,
      `${kind}: direct reference probe must remain bounded`,
    );
    const required =
      kind === "portrait" ? "people_portrait_url" : "photos_media_url";
    assert.ok(
      nodes.some((node) => node["Index Name"] === required),
      `${kind}: the URL predicate must use its RLS-safe stored-value index`,
    );
    console.log(
      JSON.stringify({
        operation: "native_media_url_plan",
        kind,
        hits: plan.Plan["Shared Hit Blocks"],
        executionMs: plan["Execution Time"],
      }),
    );
  }
  assert.equal(await access("/media/child-portrait.png", scoped), true);
  assert.equal(await access("/media/visible-gallery.png", scoped), true);
  assert.equal(
    await access("/media/filler-10000.png", scoped),
    false,
    "an untagged unrelated photo must remain hidden",
  );
  assert.equal(
    await access("/media/foreign-gallery.png", owner),
    false,
    "RLS must hide the other archive even from this archive's owner",
  );
  await first.query(
    `UPDATE people SET data=jsonb_set(data,'{photo}','"/media/updated-portrait.png"') WHERE id='child'`,
  );
  assert.equal(await access("/media/child-portrait.png", owner), false);
  assert.equal(
    await access("/media/updated-portrait.png", scoped),
    true,
    "stored columns and indexes update from the source JSON automatically",
  );
  await first.query("SELECT set_config('drevo.archive_id','tree-b',false)");
  assert.equal(await access("/media/visible-gallery.png", owner), false);
  assert.equal(await access("/media/foreign-gallery.png", owner), true);
});
