import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { openArchive } from "../../src/server/database.ts";
import { userStore } from "../../src/server/users.ts";
import { startServer } from "../../src/server/index.ts";
import { importSqliteSnapshot } from "../../ops/postgres/import-sqlite.ts";
import { archiveChanges, inverseChanges } from "../../src/domain/changes.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../../src/server/session-token.ts";
import type { Family, Person } from "../../src/domain/types.ts";
import { registerMediaUpload } from "../../src/server/media-access.ts";
import { verifyPostgresFragmentHttp } from "./postgres-fragment-http.ts";

// Explicitly disposable database only, installed under an ordinary FORCE-RLS
// role. Never infer a production connection or reuse the deployed archive.
assert.match(
  process.env.PGDATABASE || "",
  /^drevo_migration_runtime_[a-z0-9_]+$/,
);
const client = new pg.Client();
await client.connect();
const directory = mkdtempSync(join(tmpdir(), "drevo-pg-live-changes-"));
const source = join(directory, "seed.sqlite"),
  uploads = join(directory, "uploads");
mkdirSync(uploads);
let app: Awaited<ReturnType<typeof startServer>> | undefined;
const person = (id: string, birth = "1950", createdBy = "owner"): Person => ({
  id,
  name: id,
  surname: "Тест",
  patronymic: "",
  sex: "m",
  birth,
  birthPlace: "",
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
  createdBy,
});
try {
  assert.deepEqual(
    (
      await client.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0],
    { rolsuper: false, rolbypassrls: false },
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
      )
    ).rows[0].n,
    0,
  );
  delete process.env.DATABASE_BACKEND;
  delete process.env.PUBLIC_ORIGIN;
  const seed: Family = {
    title: "1001 синтетическая персона",
    description: "",
    demo: false,
    people: Array.from({ length: 1001 }, (_, i) => ({
      ...person(`p-${i}`),
      biography: `PRIVATE-BIOGRAPHY-${i} ` + "Семейная история. ".repeat(500),
      events: [{ id: "work", type: "work", description: "Нетронутое событие" }],
    })),
    links: [],
    photos: [],
  };
  const sqlite = await openArchive(source, seed);
  await (
    await userStore(sqlite.db, { initialAdminId: "owner" })
  ).register("owner", "Владелец");
  await sqlite.close();
  await importSqliteSnapshot(source, uploads, "live-deltas", client, "owner");
  process.env.DATABASE_BACKEND = "postgres";
  process.env.ARCHIVE_ID = "live-deltas";
  process.env.PUBLIC_ORIGIN = "https://bounded-mutations.invalid";
  app = await startServer(0, source, true);
  const archive = app.archive;
  const token = newSessionToken();
  await archive.db
    .prepare(
      "",
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'owner',?)",
    )
    .run(sessionTokenHash(token), Date.now() + 60_000);
  await archive.db
    .prepare(
      "",
      "UPDATE account_tiers SET full_access=true WHERE account_id='owner'",
    )
    .run();
  const initial = await archive.read(),
    next = structuredClone(initial.family);
  next.people[0].parents = ["new-ancestor"];
  next.people[0].sources = [
    { title: "Метрическая книга", type: "архив", reference: "л. 7" },
  ];
  next.people[0].events = [{ id: "work", type: "work", date: "1980" }];
  next.people.push(person("new-ancestor", "1900"));
  next.unions = [
    { id: "union", type: "partnership", participants: ["p-0", "p-1"] },
  ];
  next.links = [
    { id: "godparent", from: "new-ancestor", to: "p-1", type: "godparent" },
  ];
  const originalRead = archive.read,
    originalWrite = archive.write,
    prepare = archive.db.prepare;
  let transferredBytes = 0,
    resultRows = 0,
    statements = 0;
  archive.db.prepare = (...args) => {
    const query = prepare(...args);
    return {
      ...query,
      all: async (...values) => {
        const rows = await query.all(...values);
        transferredBytes += Buffer.byteLength(JSON.stringify(rows));
        resultRows += rows.length;
        statements++;
        return rows;
      },
    };
  };
  archive.read = async () => {
    throw new Error("Unexpected full archive read in minimal mutation");
  };
  archive.write = async () => {
    throw new Error("Unexpected full replacement in delta mutation");
  };
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const send = (
    revision: number,
    changes: ReturnType<typeof archiveChanges>,
    session = token,
  ) =>
    fetch(base + "/api/family/changes", {
      method: "POST",
      headers: {
        Origin: process.env.PUBLIC_ORIGIN!,
        Cookie: `drevo_session=${session}`,
        "Content-Type": "application/json",
        "If-Match": String(revision),
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ changes }),
    });
  const started = performance.now();
  const savedResponse = await send(
    initial.revision,
    archiveChanges(initial.family, next),
  );
  assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
  assert.equal(
    savedResponse.headers.get("Preference-Applied"),
    "return=minimal",
  );
  const saved = await savedResponse.json();
  assert.equal(saved.family, undefined);
  const metrics = {
    people: 1001,
    milliseconds: Math.round(performance.now() - started),
    transferredBytes,
    resultRows,
    resultSetQueries: statements,
    fullSnapshotBytes: Buffer.byteLength(JSON.stringify(initial.family)),
    responseBytes: JSON.stringify(saved).length,
  };
  assert.ok(metrics.transferredBytes < metrics.fullSnapshotBytes / 10);
  assert.ok(metrics.responseBytes < 8000);
  console.log("bounded_mutation_metrics", JSON.stringify(metrics));
  const stale = await send(initial.revision, [
    {
      collection: "people",
      id: "p-0",
      field: "sources",
      before: [],
      after: [{ title: "Другая книга", type: "", reference: "" }],
    },
  ]);
  assert.equal(stale.status, 409);
  const unsafe = await send(saved.revision, [
    {
      collection: "people",
      id: "p-0",
      field: "parents",
      before: ["new-ancestor"],
      after: ["p-0"],
    },
  ]);
  assert.equal(unsafe.status, 400);
  const catalog = await send(saved.revision, [
    {
      collection: "people",
      id: "p-0",
      field: "sources",
      before: next.people[0].sources,
      after: [
        {
          catalogId: "foreign-catalog-id",
          title: "Чужое",
          type: "",
          reference: "",
        },
      ],
    },
  ]);
  assert.equal(catalog.status, 400);
  const undone = await send(
    saved.revision,
    inverseChanges(saved.appliedChanges),
  );
  assert.equal(undone.status, 200, await undone.clone().text());
  archive.read = originalRead;
  archive.write = originalWrite;
  archive.db.prepare = prepare;
  assert.deepEqual(
    archiveChanges(initial.family, (await archive.read()).family),
    [],
  );
  assert.deepEqual(
    archiveChanges(
      initial.family,
      await archive.readRevision(initial.revision),
    ),
    [],
  );
  console.log("bounded_mutation_cas_catalog_undo_ok");

  await archive.db.transaction(async () => {
    await archive.db
      .prepare(
        "",
        "INSERT INTO accounts(id,name,created_at) VALUES('scoped-member','Участник',?)",
      )
      .run(new Date().toISOString());
    await archive.db
      .prepare(
        "",
        "INSERT INTO archive_memberships(archive_id,user_id,role,approved,person_id,tree_access) VALUES(current_setting('drevo.archive_id'),'scoped-member','relative',true,'p-0','common_ancestors')",
      )
      .run();
    await archive.db
      .prepare(
        "",
        "UPDATE people SET data=jsonb_set(data,'{createdBy}','\"scoped-member\"'::jsonb) WHERE id IN ('p-0','p-1')",
      )
      .run();
    await archive.db
      .prepare(
        "",
        "UPDATE people SET data=jsonb_set(data,'{photo}','\"/media/hidden.png\"'::jsonb) WHERE id='p-2'",
      )
      .run();
  });
  const memberToken = newSessionToken();
  await archive.db
    .prepare(
      "",
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'scoped-member',?)",
    )
    .run(sessionTokenHash(memberToken), Date.now() + 60_000);
  const revision = (await archive.meta()).revision;
  archive.read = async () => {
    throw new Error("Unexpected scoped full archive read");
  };
  archive.write = async () => {
    throw new Error("Unexpected scoped replacement write");
  };
  const accepted = await send(
    revision,
    [
      {
        collection: "people",
        id: "p-1",
        field: "events",
        before: seed.people[1].events,
        after: [{ id: "work", type: "work", date: "1990" }],
      },
    ],
    memberToken,
  );
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const memberSaved = await accepted.json();
  assert.equal(memberSaved.family, undefined);
  for (const change of [
    {
      collection: "people" as const,
      id: "p-1",
      field: "sources",
      before: [],
      after: [
        { title: "Скрыто", type: "", reference: "", url: "/media/hidden.png" },
      ],
    },
    {
      collection: "people" as const,
      id: "p-2",
      field: "events",
      before: seed.people[2].events,
      after: [{ id: "work", type: "work", date: "1990" }],
    },
  ]) {
    const denied = await send(memberSaved.revision, [change], memberToken);
    assert.equal(denied.status, 403, await denied.clone().text());
    assert.equal((await archive.meta()).revision, memberSaved.revision);
  }
  archive.read = originalRead;
  archive.write = originalWrite;
  console.log("bounded_mutation_scoped_privacy_ok");

  const mediaUrl = "/media/member-source.pdf";
  const citation = {
    title: "Свой скан",
    type: "архив",
    reference: "л. 1",
    url: mediaUrl,
  };
  await registerMediaUpload(archive.db, mediaUrl, "scoped-member", 17);
  let memberRevision = memberSaved.revision;
  for (const [before, after] of [
    [[], [citation]],
    [[citation], []],
    [[], [citation]],
  ] as const) {
    const response = await send(
      memberRevision,
      [{ collection: "people", id: "p-1", field: "sources", before, after }],
      memberToken,
    );
    assert.equal(response.status, 200, await response.clone().text());
    memberRevision = (await response.json()).revision;
  }
  assert.equal(
    (
      await archive.db
        .prepare(
          "",
          "SELECT count(*)::int AS n FROM media_upload_grants WHERE url=?",
        )
        .get(mediaUrl)
    )?.n,
    0,
  );
  console.log("bounded_mutation_scoped_inverse_media_undo_ok");

  const owner = (await (await userStore(archive.db)).get("owner"))!;
  const independent = await Promise.all(
    ["p-10", "p-11"].map((id) =>
      archive.patchChanges(
        [
          {
            collection: "people",
            id,
            field: "sources",
            before: [],
            after: [{ title: id, type: "", reference: "" }],
          },
        ],
        memberRevision,
        owner,
      ),
    ),
  );
  assert.deepEqual(
    independent.map((result) => result.revision).sort((a, b) => a - b),
    [memberRevision + 1, memberRevision + 2],
  );
  const beforeQuota = (await archive.meta()).revision;
  await archive.db
    .prepare(
      "",
      "UPDATE account_tiers SET full_access=false WHERE account_id='owner'",
    )
    .run();
  const quota = await send(beforeQuota, [
    {
      collection: "people",
      id: "over-quota",
      before: undefined,
      after: person("over-quota"),
    },
  ]);
  assert.equal(quota.status, 403, await quota.clone().text());
  assert.equal((await archive.meta()).revision, beforeQuota);
  assert.equal(
    await archive.db
      .prepare("", "SELECT id FROM people WHERE id='over-quota'")
      .get(),
    undefined,
  );
  console.log("bounded_mutation_concurrency_owner_quota_ok");
  await verifyPostgresFragmentHttp(archive, base, memberToken);
} finally {
  await app?.close();
  await client.end();
  rmSync(directory, { recursive: true, force: true });
}
