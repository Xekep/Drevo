import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { aiProviderCleanup } from "../../src/server/ai-provider-cleanup.ts";
import { aiProviderCleanupStatus } from "../../src/server/ai-provider-cleanup-status.ts";
import { runCodeInterpreter } from "../../src/server/code-interpreter.ts";
import { openPostgresDatabase, type StoreDatabase } from "../../src/server/store-database.ts";
import { yandexResponsesClient } from "../../src/server/yandex-responses.ts";
import type { Family } from "../../src/domain/types.ts";

const runtime = { baseUrl: "https://synthetic.invalid/v1", folderId: "old-folder",
  apiKey: "old-secret", modelUri: "gpt://old-folder/model" };
const family: Family = { title: "Synthetic", description: "", demo: false,
  people: [] };

export async function verifyAiInputFileCleanup(db: StoreDatabase, configuredPath: string) {
  const other = await openPostgresDatabase(db.archiveId!, db.file);
  const refs: string[] = [];
  const calls: Array<{ url: string; auth: string | null }> = [];
  let entered!: () => void, release!: () => void;
  const insideProvider = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let holdOnce = true;
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization") });
    if (String(url).endsWith("/two-workers") && holdOnce) {
      holdOnce = false;
      entered(); await held;
    }
    return new Response(null, { status: 404 });
  };
  const first = await aiProviderCleanup(db, configuredPath, fake as typeof fetch);
  const second = await aiProviderCleanup(other, configuredPath, fake as typeof fetch);
  const state = async (id: string) => db.prepare("", `SELECT state,attempts,
    encrypted_snapshot,last_error,available_at FROM platform_ai_input_files WHERE id=?`).get(id);
  try {
    const crashRef = await first.registerInputFile("crash-file", runtime, Date.now() + 97_000);
    refs.push(crashRef);
    assert.equal((await state(crashRef))?.state, "binding");
    assert.doesNotMatch(String((await state(crashRef))?.encrypted_snapshot), /crash-file|old-secret/);
    const publicStatus = await db.postgresTransaction!((client) =>
      aiProviderCleanupStatus(client, { filter: "all", cursor: null }));
    assert.ok(publicStatus.jobs.some((job) => job.id === crashRef &&
      job.kind === "input_file" && job.state === "binding"));
    assert.doesNotMatch(JSON.stringify(publicStatus),
      /crash-file|old-secret|old-folder|encrypted_snapshot|fileId/);
    await db.prepare("", "UPDATE platform_ai_input_files SET available_at=0 WHERE id=?").run(crashRef);
    assert.equal(await second.processInputFiles(1), 1, "a restarted worker recovers a binding");
    assert.equal((await state(crashRef))?.state, "done");
    assert.equal((await state(crashRef))?.encrypted_snapshot, null);

    const competing = await first.registerInputFile("two-workers", runtime, Date.now() + 97_000);
    refs.push(competing);
    await first.queueInputFile(competing);
    const one = first.processInputFiles(1);
    await insideProvider;
    assert.equal(await second.processInputFiles(1), 0,
      "another worker cannot claim a live lease while HTTP is in flight");
    const blocker = await other.postgresTransaction!(async (client) => {
      const row = await client.query("SELECT id FROM platform_ai_input_files WHERE id=$1 FOR UPDATE NOWAIT",
        [competing]);
      return row.rowCount;
    });
    assert.equal(blocker, 1, "provider HTTP holds no SQL row lock");
    await db.prepare("", "UPDATE platform_ai_input_files SET lease_until=0 WHERE id=?")
      .run(competing);
    assert.equal(await second.processInputFiles(1), 1,
      "expired lease may be reclaimed by another worker");
    release();
    assert.equal(await one, 1);
    assert.equal((await state(competing))?.state, "done");
    assert.equal(Number((await state(competing))?.attempts), 2,
      "stale acknowledgement cannot replace the newer worker result");

    for (const [status, expected] of [[200, "done"], [429, "pending"], [503, "pending"],
      [401, "blocked"], [403, "blocked"], [404, "done"]] as const) {
      const cleanup = await aiProviderCleanup(db, configuredPath, async () =>
        new Response(null, { status }));
      const id = await cleanup.registerInputFile(`status-${status}`, runtime, Date.now() + 97_000);
      refs.push(id);
      await cleanup.queueInputFile(id);
      assert.equal(await cleanup.processInputFiles(1), 1);
      assert.equal((await state(id))?.state, expected);
      assert.equal((await state(id))?.encrypted_snapshot === null, expected === "done");
      if (expected === "pending")
        assert.ok(Number((await state(id))?.available_at) > Date.now());
    }

    const beforeChange = await first.registerInputFile("original-key", runtime, Date.now() + 97_000);
    refs.push(beforeChange);
    await first.queueInputFile(beforeChange);
    const previousKey = process.env.YANDEX_AI_API_KEY;
    process.env.YANDEX_AI_API_KEY = "changed-secret";
    try { assert.equal(await second.processInputFiles(1), 1); }
    finally {
      if (previousKey === undefined) delete process.env.YANDEX_AI_API_KEY;
      else process.env.YANDEX_AI_API_KEY = previousKey;
    }
    assert.equal((await state(beforeChange))?.state, "done");
    assert.ok(calls.some((call) => call.url.endsWith("/files/original-key") &&
      call.auth === "Api-Key old-secret"), "worker uses encrypted original credentials");

    let modelSawBinding = false;
    const uploaded = `healthy-${randomUUID().slice(0, 8)}`;
    const known = new Set(refs);
    const healthyClient = yandexResponsesClient(async (url) => {
      if (String(url).endsWith("/files")) return Response.json({ id: uploaded });
      const current = await db.prepare("", `SELECT id,encrypted_snapshot,state
        FROM platform_ai_input_files WHERE state='binding' ORDER BY created_at DESC`).all();
      modelSawBinding = current.some((row) => !known.has(String(row.id)) &&
        row.state === "binding" && !String(row.encrypted_snapshot).includes(uploaded));
      return Response.json({ status: "completed", output: [] });
    });
    const incomplete = await runCodeInterpreter({ client: healthyClient,
      runtime, family, input: { task: "1+1", fields: ["birth"] },
      signal: new AbortController().signal, allowPdf: false,
      inputFileCleanup: first, onCall() {}, onUsage() {} });
    assert.equal(incomplete.error, "CALCULATION_INCOMPLETE");
    assert.equal(modelSawBinding, true, "ID is durably bound before model request");
    const healthyRef = String((await db.prepare("", `SELECT id FROM platform_ai_input_files
      WHERE state='pending' AND created_at>0 ORDER BY created_at DESC,id DESC LIMIT 1`).get())?.id);
    refs.push(healthyRef);
    assert.equal(await second.processInputFiles(1), 1);
    assert.equal((await state(healthyRef))?.state, "done");

    const account = `input-cleanup-${randomUUID()}`;
    await db.prepare("", "INSERT INTO accounts(id,name,created_at) VALUES(?,?,'2026-01-01')")
      .run(account, "Synthetic");
    const survives = await first.registerInputFile("after-account-delete", runtime, Date.now() + 97_000);
    refs.push(survives);
    try {
      await db.prepare("", "DELETE FROM accounts WHERE id=?").run(account);
      assert.equal((await state(survives))?.state, "binding",
        "platform obligation survives account deletion");
    } finally {
      await db.prepare("", "DELETE FROM accounts WHERE id=?").run(account);
    }

    const uploadedId = `input-${randomUUID().slice(0, 8)}`;
    let modelCalls = 0;
    const previousCalls = calls.length;
    const client = yandexResponsesClient(async (url, init) => {
      if (init?.method === "DELETE") return Response.json({ deleted: true });
      if (String(url).endsWith("/files")) return Response.json({ id: uploadedId });
      modelCalls++; return Response.json({ status: "completed", output: [] });
    });
    const rejected = await runCodeInterpreter({ client, runtime, family,
      input: { task: "1+1", fields: ["birth"] },
      signal: new AbortController().signal, allowPdf: false,
      attachments: [{ name: "input.csv", type: "text/csv", bytes: Buffer.from("x") }],
      inputFileCleanup: { registerInputFile: async () => { throw new Error("ledger unavailable"); },
        queueInputFile: first.queueInputFile, compensateInputFile: first.compensateInputFile },
      onCall() {}, onUsage() {} });
    assert.equal(rejected.error, "CALCULATION_UNAVAILABLE");
    assert.equal(modelCalls, 0, "unregistered ID is never used");
    assert.deepEqual(calls.slice(previousCalls), [{
      url: `${runtime.baseUrl}/files/${uploadedId}`, auth: "Api-Key old-secret",
    }], "original runtime compensates failed registration");
    console.log("PostgreSQL: input Files crash recovery, two workers, credential snapshot and failed registration verified");
  } finally {
    release();
    for (const id of refs)
      await db.prepare("", "DELETE FROM platform_ai_input_files WHERE id=?").run(id);
    await other.close();
  }
}
