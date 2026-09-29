import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import pg from "pg";
import sharp from "sharp";
import { openArchive } from "../../src/server/database.ts";
import { userStore } from "../../src/server/users.ts";
import { importSqliteSnapshot } from "./import-sqlite.ts";
import type { Family } from "../../src/domain/types.ts";

// This is a disposable test database, never an archive supplied by an operator.
assert.match(process.env.PGDATABASE || "", /^drevo_migration_bench_[a-z0-9_]+$/);
const count = Number(process.argv[2] || 1000);
const seconds = Number(process.argv[3] || 45);
assert.ok(Number.isInteger(count) && count >= 1000 && count <= 10000);
assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 300);
const client = new pg.Client({ connectionTimeoutMillis: 5000 });
await client.connect();
const identity = (await client.query(
  "SELECT current_database() AS name, version() AS version, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
)).rows[0];
assert.equal(identity.name, process.env.PGDATABASE);
assert.equal(identity.rolsuper, false);
assert.equal(identity.rolbypassrls, false);
assert.equal((await client.query(
  "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
)).rows[0].n, 0, "Benchmark requires a NEW empty database");

const directory = mkdtempSync(join(tmpdir(), "drevo-http-bench-"));
const source = join(directory, "synthetic.sqlite");
mkdirSync(join(directory, "uploads"));
const children: ChildProcess[] = [];
try {
  const family: Family = {
    title: "Синтетический HTTP-архив",
    description: "", demo: false, photos: [], links: [],
    people: Array.from({ length: count }, (_, i) => ({
      id: `person-${i}`, name: `Человек ${i}`, surname: "Тестов",
      patronymic: "", sex: "m" as const, birth: "1980", birthPlace: "",
      parents: i % 2 ? [`person-${i - 1}`] : [], spouses: [], sources: [],
      biography: "Синтетическая биография. ".repeat(10),
      generation: (i % 2) + 1, column: i, createdBy: "owner",
    })),
  };
  delete process.env.DATABASE_BACKEND;
  const sqlite = await openArchive(source, family);
  try { await (await userStore(sqlite.db, { initialAdminId: "owner" })).register("owner", "Владелец"); }
  finally { await sqlite.close(); }
  await importSqliteSnapshot(source, join(directory, "uploads"), "http-benchmark", client, "owner");
  process.env.DATABASE_BACKEND = "postgres";
  process.env.ARCHIVE_ID = "http-benchmark";
  process.env.DREVO_BENCH_DATA_PATH = source;

  async function launch() {
    const child = fork(join(import.meta.dirname, "benchmark-http-worker.ts"), [], {
      execArgv: ["--experimental-strip-types"],
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.pipe(process.stderr);
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Backend startup timed out")), 30000);
      child.once("message", (message) => {
        clearTimeout(timeout);
        if (message && typeof message === "object" && "port" in message &&
            typeof message.port === "number") resolve(message.port);
        else reject(new Error("Invalid backend startup message"));
      });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Backend exited: ${code}`)); });
    });
    return `http://127.0.0.1:${port}`;
  }
  const bases = await Promise.all([launch(), launch()]);
  const initial = await fetch(bases[0] + "/api/family?projection=overview").then(r => r.json());
  assert.equal(initial.totals.people, count);
  const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#558855" } }).png().toBuffer();
  const uploaded = await fetch(bases[0] + "/api/photos", {
    method: "POST", headers: { Origin: bases[0], "X-Drevo-Upload": "1", "If-Match": String(initial.revision) }, body: png,
  });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const photoUrl = (await uploaded.json()).family.photos[0].url as string;
  assert.ok(photoUrl.startsWith("/media/"));
  for (const base of bases) {
    const result = await fetch(base + photoUrl + "?variant=thumb");
    assert.equal(result.status, 200, "Both processes must see shared media");
    assert.equal(result.headers.get("content-type"), "image/webp");
    await result.arrayBuffer();
  }
  const routes = [
    ["overview", "/api/family?projection=overview"],
    ["full_archive", "/api/family"],
    ["search", "/api/people/search?q=Тестов"],
    ["documents", "/api/documents?limit=20"],
    ["ai_status", "/api/ai/status"],
    ["media_thumb", photoUrl + "?variant=thumb"],
  ] as const;
  const results = new Map<string, { durations: number[]; bytes: number; errors: number }>(
    routes.map(([name]) => [name, { durations: [], bytes: 0, errors: 0 }]),
  );
  const concurrency = 12;
  const until = performance.now() + seconds * 1000;
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < until) {
      const index = next++;
      const [name, path] = routes[index % routes.length];
      const base = bases[index % bases.length];
      const metric = results.get(name)!;
      const began = performance.now();
      try {
        const response = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
        const bytes = (await response.arrayBuffer()).byteLength;
        if (response.status !== 200) metric.errors++;
        else metric.bytes += bytes;
      } catch { metric.errors++; }
      metric.durations.push(performance.now() - began);
    }
  }));
  const elapsedMs = performance.now() - started;
  const processMetrics = await Promise.all(children.map(child => new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Backend metrics timed out")), 5000);
    child.once("message", (message) => {
      clearTimeout(timeout);
      resolve(message && typeof message === "object" && "metrics" in message ? message.metrics : null);
    });
    child.send("metrics");
  })));
  const percentile = (values: number[], p: number) => {
    values.sort((a, b) => a - b);
    return Math.round((values[Math.ceil(values.length * p) - 1] || 0) * 10) / 10;
  };
  console.log(JSON.stringify({ environment: {
    node: process.version, postgres: identity.version, cpu: cpus()[0]?.model,
    cores: cpus().length, memoryBytes: totalmem(), people: count,
    processes: processMetrics,
    concurrency, durationSeconds: Math.round(elapsedMs / 1000),
    scope: "isolated local HTTP, synthetic data; AI status only, no model inference or background jobs",
  }}));
  for (const [operation, metric] of results) {
    const samples = metric.durations.length;
    console.log(JSON.stringify({ operation, samples, errors: metric.errors,
      p50Ms: percentile(metric.durations, 0.5), p95Ms: percentile(metric.durations, 0.95),
      p99Ms: percentile(metric.durations, 0.99), bytesReceived: metric.bytes,
      successfulOpsPerSecond: Math.round(((samples - metric.errors) * 1000) / elapsedMs),
    }));
    assert.ok(samples > 0 && metric.errors === 0, `${operation}: HTTP errors`);
  }
} finally {
  await Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 20000).unref();
  })));
  await client.end();
  rmSync(directory, { recursive: true, force: true });
}
