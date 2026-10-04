import { startServer } from "../../src/server/index.ts";
import { backupCoordinator, BackupBusyError } from "../../src/server/backup-coordinator.ts";
import { aiProviderCleanup } from "../../src/server/ai-provider-cleanup.ts";

if (process.env.DATABASE_BACKEND !== "postgres" ||
    !/^drevo_migration_bench_[a-z0-9_]+$/.test(process.env.PGDATABASE || ""))
  throw new Error("HTTP benchmark requires an isolated PostgreSQL database");

const fakeOrigin = "https://benchmark.invalid";
let nextResponse = 0;
const aiFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== fakeOrigin)
    throw new Error("HTTP benchmark blocks external AI requests");
  if (init?.method === "DELETE" &&
      /^\/v1\/conversations\/benchmark-conversation-[0-9]+-[0-9]+$/.test(url.pathname)) {
    if ((init.headers as Record<string, string>)?.Authorization !== "Api-Key benchmark-only-key")
      throw new Error("Synthetic cleanup did not use the original credential");
    process.send?.({ aiDelete: url.pathname });
    return new Response(null, { status: 204 });
  }
  if (init?.method !== "POST")
    throw new Error("HTTP benchmark blocks unexpected AI request");
  if (url.pathname === "/v1/conversations")
    return Response.json({ id: `benchmark-conversation-${process.pid}-${++nextResponse}` });
  if (url.pathname === "/v1/responses") {
    const request = JSON.parse(String(init.body)) as { stream?: boolean; input?: unknown };
    if (request.stream) throw new Error("HTTP benchmark expects a non-stream AI turn");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const input = JSON.stringify(request.input || "");
    if (input.includes("PDF-проверка между процессами") || input.includes("function_call_output")) {
      const completed = input.includes("function_call_output");
      return Response.json({
        id: `benchmark-response-${process.pid}-${++nextResponse}`,
        status: "completed",
        output_text: completed ? "Синтетический PDF создан." : "",
        output: completed ? [] : [{ type: "function_call", call_id: "benchmark-pdf",
          name: "create_pdf", arguments: JSON.stringify({
            title: "Проверка двух процессов", content: "Только синтетические данные архива.",
          }) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    }
    return Response.json({
      id: `benchmark-response-${process.pid}-${++nextResponse}`,
      status: "completed",
      output_text: "Синтетический ответ ИИ для проверки HTTP-профиля.",
      output: [],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  }
  throw new Error("HTTP benchmark blocks unexpected AI endpoint");
};

const app = await startServer(0, process.env.DREVO_BENCH_DATA_PATH, true,
  undefined, aiFetch);
process.send?.({ port: (app.server.address() as { port: number }).port });
process.on("message", (message) => {
  if (message === "cleanup-provider") {
    process.env.YANDEX_AI_API_KEY = "rotated-benchmark-key";
    void aiProviderCleanup(app.archive.db, process.env.DREVO_BENCH_DATA_PATH!, aiFetch)
      .then((cleanup) => cleanup.process(1))
      .then(() => process.send?.({ aiCleanupDone: true }))
      .catch(() => process.send?.({ aiCleanupError: true }))
      .finally(() => { process.env.YANDEX_AI_API_KEY = "benchmark-only-key"; });
  }
  if (message === "metrics")
    process.send?.({ metrics: { pid: process.pid, rssBytes: process.memoryUsage().rss,
      cpu: process.cpuUsage() } });
  if (message === "backup-records") void app.archive.db.prepare("",
    "SELECT count(*)::int AS n FROM backup_catalog").get()
    .then((row) => process.send?.({ backupRecords: Number(row?.n || 0) }));
  if (message === "backup") void (async () => {
    const backups = await backupCoordinator(app.archive.db,
      process.env.DREVO_BENCH_DATA_PATH!, { schedule: false });
    try {
      await backups.startCreate();
      await backups.idle();
      const status = await backups.status("system");
      process.send?.({ backup: { state: status.job?.state,
        error: status.job?.error, records: status.records.length } });
    } catch (error) {
      process.send?.({ backup: { state: error instanceof BackupBusyError ? "busy" : "failed",
        error: error instanceof Error ? error.message : String(error) } });
    } finally {
      await backups.close();
    }
  })();
});

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
  });
}
