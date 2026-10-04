import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { openArchive, ConflictError } from "../../src/server/database.ts";
import { userStore } from "../../src/server/users.ts";
import { importSqliteSnapshot } from "./import-sqlite.ts";
import type { Family } from "../../src/domain/types.ts";
import type { Change } from "../../src/domain/changes.ts";

// Never benchmark an existing archive, even if someone supplies its credentials.
assert.match(
  process.env.PGDATABASE || "",
  /^drevo_migration_bench_[a-z0-9_]+$/,
);
const count = Number(process.argv[2] || 1000);
assert.ok(Number.isInteger(count) && count >= 1000 && count <= 10000);
const client = new pg.Client({ connectionTimeoutMillis: 5000 });
await client.connect();
const directory = mkdtempSync(join(tmpdir(), "drevo-pg-bench-"));
const archives: Awaited<ReturnType<typeof openArchive>>[] = [];
const source = join(directory, "synthetic.sqlite");
const uploads = join(directory, "uploads");
mkdirSync(uploads);
try {
  const identity = (
    await client.query(
      "SELECT current_database() AS name, version() AS version, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert.equal(identity.name, process.env.PGDATABASE);
  assert.equal(identity.rolsuper, false);
  assert.equal(identity.rolbypassrls, false);
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
      )
    ).rows[0].n,
    0,
    "Benchmark requires a NEW empty database",
  );
  const family: Family = {
    title: "Синтетический нагрузочный архив",
    description: "",
    demo: false,
    people: Array.from({ length: count }, (_, i) => ({
      id: `person-${i}`,
      name: `Человек ${i}`,
      surname: "Тестов",
      patronymic: "",
      sex: "m",
      birth: i % 2 ? "1980" : "1950",
      birthPlace: "",
      parents: i % 2 ? [`person-${i - 1}`] : [],
      spouses: [],
      sources: [],
      biography: "Синтетическая биография. ".repeat(20),
      generation: (i % 2) + 1,
      column: i,
      createdBy: "owner",
    })),
    photos: [],
    links: [],
  };
  delete process.env.DATABASE_BACKEND;
  const sqlite = await openArchive(source, family);
  try {
    const users = await userStore(sqlite.db, { initialAdminId: "owner" });
    await users.register("owner", "Тестовый владелец");
  } finally {
    await sqlite.close();
  }
  await importSqliteSnapshot(
    source,
    uploads,
    "benchmark-archive",
    client,
    "owner",
  );
  process.env.DATABASE_BACKEND = "postgres";
  process.env.ARCHIVE_ID = "benchmark-archive";
  for (let i = 0; i < 2; i++) archives.push(await openArchive(source, family));
  const benchmarkActor = await (await userStore(archives[0].db)).get("owner");
  assert.ok(benchmarkActor?.approved && benchmarkActor.archiveOwner &&
    benchmarkActor.treeRole === "relative",
  "the benchmark uses the imported owner's current PostgreSQL grant");
  console.log(
    JSON.stringify({
      environment: {
        node: process.version,
        postgres: identity.version,
        cpu: cpus()[0]?.model,
        cpus: cpus().length,
        memoryBytes: totalmem(),
        people: count,
        pools: 2,
        poolMaxConnections: 10,
        transport: "StoreDatabase; no HTTP or browser",
      },
    }),
  );

  async function measure(
    operation: string,
    concurrency: number,
    samples: number,
    work: (index: number) => Promise<unknown>,
  ) {
    const durations: number[] = [],
      errors: Record<string, number> = {};
    let next = 0,
      succeeded = 0;
    let unexpectedError: unknown;
    const cpu = process.cpuUsage(),
      started = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < samples) {
          const index = next++,
            began = performance.now();
          try {
            await work(index);
            succeeded++;
          } catch (error) {
            const queueTimeout =
              error instanceof Error &&
              error.message === "timeout exceeded when trying to connect";
            const code = queueTimeout
              ? "connection_queue_timeout"
              : error && typeof error === "object" && "code" in error
                ? String(error.code)
                : "error";
            errors[code] = (errors[code] || 0) + 1;
            // Revisioned snapshots now pass this profile without queue timeouts.
            // Report saturation, but fail CI if that regression comes back.
            unexpectedError ??= error;
          } finally {
            durations.push(performance.now() - began);
          }
        }
      }),
    );
    const elapsedMs = performance.now() - started,
      cpuUsed = process.cpuUsage(cpu);
    durations.sort((a, b) => a - b);
    const percentile = (p: number) =>
      Math.round(durations[Math.ceil(samples * p) - 1] * 10) / 10;
    console.log(
      JSON.stringify({
        operation,
        concurrency,
        samples,
        succeeded,
        errors,
        overloaded: !!errors.connection_queue_timeout,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        elapsedMs: Math.round(elapsedMs),
        successfulOpsPerSecond: Math.round((succeeded * 1000) / elapsedMs),
        nodeCpuMs: Math.round((cpuUsed.user + cpuUsed.system) / 1000),
        nodeLifetimePeakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
    if (unexpectedError) throw unexpectedError;
    assert.ok(succeeded > 0, `${operation}: no successful requests`);
  }
  await measure("cold_full_archive_burst", 100, 100, async (i) => {
    assert.equal((await archives[i % 2].read()).family.people.length, count);
  });
  // Warm connections and queries; record small closed-loop batches, not user capacity.
  for (const archive of archives) {
    await archive.read();
    await archive.overview();
  }
  for (const concurrency of [1, 10, 100]) {
    const samples = Math.max(30, concurrency * 2);
    await measure("full_archive_read", concurrency, samples, async (i) => {
      const snapshot = await archives[i % 2].read();
      assert.equal(snapshot.family.people.length, count);
    });
    await measure("tree_overview", concurrency, samples, async (i) => {
      const snapshot = await archives[i % 2].overview();
      assert.equal(snapshot.family.people.length, count);
    });
    const before = await archives[0].read();
    const changes: Change[] = before.family.people
      .slice(0, samples)
      .map((person, i) => ({
        collection: "people",
        id: person.id,
        field: "biography",
        before: person.biography,
        after: `Правка ${concurrency}:${i}`,
      }));
    await measure("independent_card_edits", concurrency, samples, async (i) => {
      assert.ok(
        await archives[i % 2].patchPeople([changes[i]], before.revision, benchmarkActor),
      );
    });
    const after = await archives[1].read();
    assert.equal(
      after.revision,
      before.revision + samples,
      "No lost or duplicate revisions",
    );
    const people = new Map(after.family.people.map((p) => [p.id, p]));
    for (const change of changes)
      assert.equal(people.get(change.id!)!.biography, change.after);
  }
  const batchStart = await archives[0].read();
  const batchPeople = batchStart.family.people
    .filter((p) => p.parents.length === 0)
    .slice(0, 500);
  await measure("batch_edit_500_people", 1, 10, async (i) => {
    const changes: Change[] = batchPeople.map((person) => ({
      collection: "people",
      id: person.id,
      field: "biography",
      before: person.biography,
      after: `Пакет ${i}`,
    }));
    const result = await archives[i % 2].patchPeople(
      changes,
      batchStart.revision,
      benchmarkActor,
    );
    assert.equal(result?.appliedChanges.length, 500);
    for (const person of batchPeople) person.biography = `Пакет ${i}`;
  });
  const before = await archives[0].read();
  assert.equal(before.revision, batchStart.revision + 10);
  const base: Change = {
    collection: "people",
    id: "person-0",
    field: "biography",
    before: before.family.people.find((p) => p.id === "person-0")!.biography,
    after: "Конкурент A",
  };
  const attempts = await Promise.allSettled(
    archives.map((archive, i) =>
      archive.patchPeople(
        [{ ...base, after: `Конкурент ${i}` }],
        before.revision,
        benchmarkActor,
      ),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = attempts.find((r) => r.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" && rejected.reason instanceof ConflictError,
  );
  assert.equal((await archives[0].meta()).revision, before.revision + 1);
  const saved = await archives[1].read();
  const same = {
    ...base,
    after: saved.family.people.find((p) => p.id === "person-0")!.biography,
  };
  await Promise.all(
    archives.map((a) => a.patchPeople([same], before.revision, benchmarkActor)),
  );
  assert.equal(
    (await archives[0].meta()).revision,
    saved.revision,
    "Retries must not write again",
  );
  // Each revision has an exact matching value. Readers racing a writer may
  // see either version, but must never attach a newer revision to old data.
  let mixedRevision = saved.revision + 1;
  let marker = `mixed-${mixedRevision}`;
  await archives[0].patchPeople(
    [{ ...same, before: same.after, after: marker }],
    saved.revision,
    benchmarkActor,
  );
  await Promise.all([
    (async () => {
      for (let i = 0; i < 10; i++) {
        const next = `mixed-${mixedRevision + 1}`;
        await archives[0].patchPeople(
          [{ ...base, before: marker, after: next }],
          mixedRevision,
          benchmarkActor,
        );
        mixedRevision++;
        marker = next;
      }
    })(),
    measure("reads_during_edits", 10, 100, async (i) => {
      const snapshot = await archives[i % 2].read();
      assert.equal(
        snapshot.family.people.find((p) => p.id === "person-0")!.biography,
        `mixed-${snapshot.revision}`,
      );
    }),
  ]);
  console.log(
    JSON.stringify({
      verified: true,
      independentEdits: 260,
      sameFieldConflict: true,
      retryIdempotency: true,
      mixedRevisionConsistency: true,
      data: "synthetic only",
    }),
  );
} finally {
  await Promise.all(archives.map((a) => a.close()));
  await client.end();
  // This directory is uniquely created above, never supplied by the caller.
  rmSync(directory, { recursive: true, force: true });
}
