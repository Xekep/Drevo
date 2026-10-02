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
      // Never use an operator's AI credentials or endpoint in this profile.
      env: { ...process.env, YANDEX_AI_API_KEY: "benchmark-only-key",
        YANDEX_AI_FOLDER_ID: "benchmark-only-folder", YANDEX_AI_MODEL: "benchmark-only-model",
        YANDEX_AI_BASE_URL: "https://benchmark.invalid/v1" },
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
  // A flat-color PNG compresses to almost nothing and understates file traffic.
  const pixels = Buffer.alloc(256 * 256 * 3);
  let seed = 0x13579bdf;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const png = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
  assert.ok(png.length > 100_000, "Synthetic original must exercise real file traffic");
  const uploaded = await fetch(bases[0] + "/api/photos", {
    method: "POST", headers: { Origin: bases[0], "X-Drevo-Upload": "1", "If-Match": String(initial.revision) }, body: png,
  });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const photoUrl = (await uploaded.json()).family.photos[0].url as string;
  assert.ok(photoUrl.startsWith("/media/"));
  for (const base of bases) {
    for (const [path, type] of [[photoUrl, "image/png"],
      [photoUrl + "?variant=thumb", "image/webp"]]) {
      const result = await fetch(base + path);
      assert.equal(result.status, 200, "Both processes must see shared media");
      assert.equal(result.headers.get("content-type"), type);
      await result.arrayBuffer();
    }
  }
  // Both processes race for a cold shared preview, exercising the disk cache
  // publication path rather than only the warm-cache path in the timed loop.
  const coldPreviews = await Promise.all(bases.map(async (base) => {
    const response = await fetch(base + photoUrl + "?variant=display");
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const decoded = await sharp(bytes).raw().toBuffer();
    assert.ok(decoded.length > 0, "Cold preview must decode fully");
    return bytes;
  }));
  assert.deepEqual(coldPreviews[0], coldPreviews[1]);
  // The two child processes have independent memory. A generated PDF must be
  // downloaded through the other process and disappear after chat deletion.
  const pdfResponse = await fetch(bases[0] + "/api/ai/chat", {
    method: "POST", headers: { Origin: bases[0], "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Сделай PDF-проверка между процессами" }),
    signal: AbortSignal.timeout(30000),
  });
  const pdfRaw = await pdfResponse.text();
  assert.equal(pdfResponse.status, 200, pdfRaw);
  const pdfTurn = JSON.parse(pdfRaw) as {
    chatId: string; files: Array<{ name: string; url: string }>;
  };
  assert.equal(pdfTurn.files.length, 1, "The fake provider must create one PDF");
  assert.match(pdfTurn.files[0].url, /^\/api\/ai\/files\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/i);
  const remotePdf = await fetch(bases[1] + pdfTurn.files[0].url);
  assert.equal(remotePdf.status, 200,
    remotePdf.status === 200 ? "" : await remotePdf.clone().text());
  assert.equal(Buffer.from(await remotePdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  const firstBackend = children[0];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Backend restart timed out")), 15000);
    firstBackend.once("exit", () => { clearTimeout(timeout); resolve(); });
    firstBackend.kill("SIGTERM");
  });
  children.splice(children.indexOf(firstBackend), 1);
  bases[0] = await launch();
  const restartedPdf = await fetch(bases[0] + pdfTurn.files[0].url);
  assert.equal(restartedPdf.status, 200,
    "A restarted backend must read the PDF from shared temporary storage");
  await restartedPdf.arrayBuffer();
  const deletedPdfChat = await fetch(bases[1] + `/api/ai/chats/${pdfTurn.chatId}`, {
    method: "DELETE", headers: { Origin: bases[1] },
  });
  assert.equal(deletedPdfChat.status, 200, await deletedPdfChat.clone().text());
  assert.equal((await fetch(bases[0] + pdfTurn.files[0].url)).status, 404,
    "Chat deletion on another process must revoke the generated file");
  const routes = [
    ["overview", "/api/family?projection=overview"],
    ["full_archive", "/api/family"],
    ["search", "/api/people/search?q=Тестов"],
    ["documents", "/api/documents?limit=20"],
    ["ai_status", "/api/ai/status"],
    ["media_original", photoUrl],
    ["media_thumb", photoUrl + "?variant=thumb"],
  ] as const;
  const results = new Map<string, { durations: number[]; bytes: number; errors: number }>(
    routes.map(([name]) => [name, { durations: [], bytes: 0, errors: 0 }]),
  );
  results.set("edit", { durations: [], bytes: 0, errors: 0 });
  results.set("ai_mock_turn", { durations: [], bytes: 0, errors: 0 });
  results.set("backup_job", { durations: [], bytes: 0, errors: 0 });
  results.set("backup_lease_rejection", { durations: [], bytes: 0, errors: 0 });
  const concurrency = 12;
  const until = performance.now() + seconds * 1000;
  let next = 0;
  const started = performance.now();
  const readers = Array.from({ length: concurrency }, async () => {
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
  });
  // A steady writer runs through both backends while readers use both caches.
  // Each edit touches a different card, so a conflict is a benchmark failure.
  const writer = (async () => {
    const metric = results.get("edit")!;
    let personIndex = 0;
    while (performance.now() < until && personIndex < count) {
      const base = bases[personIndex % bases.length];
      const began = performance.now();
      try {
        const overview = await fetch(base + "/api/family?projection=overview", {
          signal: AbortSignal.timeout(15000),
        });
        assert.equal(overview.status, 200);
        const { revision } = await overview.json() as { revision: number };
        const edited = await fetch(base + "/api/family/changes", {
          method: "POST",
          headers: { Origin: base, "Content-Type": "application/json",
            "If-Match": String(revision), Prefer: "return=minimal" },
          body: JSON.stringify({ changes: [{ collection: "people",
            id: `person-${personIndex}`, field: "occupation",
            after: `Проверка ${personIndex}` }] }),
          signal: AbortSignal.timeout(15000),
        });
        const bytes = (await edited.arrayBuffer()).byteLength;
        if (edited.status !== 200) metric.errors++;
        else { metric.bytes += bytes; personIndex++; }
      } catch { metric.errors++; }
      metric.durations.push(performance.now() - began);
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    return personIndex;
  })();
  // Two real HTTP turns overlap the readers and writer, but the Responses API
  // itself is an in-process fake with fixed latency and no network access.
  const aiTurns = (async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const metric = results.get("ai_mock_turn")!;
    await Promise.all(bases.map(async (base, index) => {
      const began = performance.now();
      try {
        const response = await fetch(base + "/api/ai/chat", {
          method: "POST",
          headers: { Origin: base, "Content-Type": "application/json" },
          body: JSON.stringify({ message: `Проверь синтетический архив ${index}` }),
          signal: AbortSignal.timeout(30000),
        });
        const raw = await response.text();
        assert.equal(response.status, 200, raw);
        const { chatId, answer } = JSON.parse(raw) as { chatId: string; answer: string };
        assert.match(answer, /Синтетический ответ ИИ/);
        assert.match(chatId, /^[a-f0-9-]{36}$/i);
        const history = await fetch(bases[1 - index] + `/api/ai/chats/${chatId}`, {
          signal: AbortSignal.timeout(15000),
        });
        const historyRaw = await history.text();
        assert.equal(history.status, 200, historyRaw);
        assert.ok(historyRaw.includes(answer), "The other backend must see the AI answer");
        metric.bytes += Buffer.byteLength(raw) + Buffer.byteLength(historyRaw);
      } catch (error) {
        metric.errors++;
        console.error("Synthetic AI turn failed", error);
      }
      metric.durations.push(performance.now() - began);
    }));
  })();
  const backgroundBackup = (async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    // Both workers ask their independent coordinators to create a managed
    // backup at once. One lease must win; the loser must report busy rather
    // than treating the other process's job as its own.
    const began = performance.now();
    try {
      const outcomes = await Promise.all(children.map(child => new Promise<{
        state?: string; error?: string; records?: number; durationMs: number;
      }>((resolve, reject) => {
        const attemptAt = performance.now();
        const timer = setTimeout(() => {
          child.off("message", received);
          reject(new Error("Background backup attempt timed out"));
        }, 60000);
        const received = (message: unknown) => {
          if (!message || typeof message !== "object" || !("backup" in message)) return;
          clearTimeout(timer);
          child.off("message", received);
          resolve({ ...(message.backup as object), durationMs: performance.now() - attemptAt });
        };
        child.on("message", received);
        child.send("backup");
      })));
      const winner = outcomes.find(outcome => outcome.state === "succeeded");
      const loser = outcomes.find(outcome => outcome.state === "busy");
      assert.equal(outcomes.filter(outcome => outcome.state === "succeeded").length, 1,
        `Exactly one process must own the backup lease: ${JSON.stringify(outcomes)}`);
      assert.equal(outcomes.filter(outcome => outcome.state === "busy").length, 1,
        `Other process must reject the foreign lease: ${JSON.stringify(outcomes)}`);
      assert.equal(winner?.records, 1, "Background job must publish one copy");
      results.get("backup_job")!.durations.push(winner!.durationMs);
      results.get("backup_lease_rejection")!.durations.push(loser!.durationMs);
      const other = children[1];
      const remoteCount = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          other.off("message", received);
          reject(new Error("Other backend backup catalog read timed out"));
        }, 5000);
        const received = (message: unknown) => {
          if (!message || typeof message !== "object" || !("backupRecords" in message)) return;
          clearTimeout(timer);
          other.off("message", received);
          resolve(Number(message.backupRecords));
        };
        other.on("message", received);
        other.send("backup-records");
      });
      assert.equal(remoteCount, 1, "Other backend must see the background copy");
    } catch (error) {
      results.get("backup_job")!.errors++;
      console.error("Synthetic background backup failed", error);
    }
    if (results.get("backup_job")!.durations.length === 0)
      results.get("backup_job")!.durations.push(performance.now() - began);
    if (results.get("backup_lease_rejection")!.durations.length === 0)
      results.get("backup_lease_rejection")!.durations.push(performance.now() - began);
  })();
  const [, writes] = await Promise.all([Promise.all(readers), writer, aiTurns, backgroundBackup]);
  assert.ok(writes > 0, "No edits completed during mixed HTTP load");
  const final = await fetch(bases[1] + "/api/family").then(r => r.json());
  assert.equal(final.family.people.find((person: { id: string }) =>
    person.id === `person-${writes - 1}`)?.occupation, `Проверка ${writes - 1}`,
  "The other backend must observe the last edit");
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
    scope: "isolated local HTTP, synthetic archive and media; cold shared preview and two simultaneous background backup attempts for one lease during mixed traffic; two AI turns against an in-process fake with 150 ms provider delay; no external model or network",
  }}));
  for (const [operation, metric] of results) {
    const samples = metric.durations.length;
    console.log(JSON.stringify({ operation, samples, errors: metric.errors,
      p50Ms: percentile(metric.durations, 0.5), p95Ms: percentile(metric.durations, 0.95),
      p99Ms: percentile(metric.durations, 0.99), bytesReceived: metric.bytes,
      successfulOpsPerSecond: Math.round(((samples - metric.errors) * 1000) / elapsedMs),
    }));
    assert.ok(samples > 0 && metric.errors === 0, `${operation}: operation errors`);
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
