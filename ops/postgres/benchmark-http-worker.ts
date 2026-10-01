import { startServer } from "../../src/server/index.ts";

if (process.env.DATABASE_BACKEND !== "postgres" ||
    !/^drevo_migration_bench_[a-z0-9_]+$/.test(process.env.PGDATABASE || ""))
  throw new Error("HTTP benchmark requires an isolated PostgreSQL database");

const fakeOrigin = "https://benchmark.invalid";
let nextResponse = 0;
const aiFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== fakeOrigin || init?.method !== "POST")
    throw new Error("HTTP benchmark blocks external AI requests");
  if (url.pathname === "/v1/conversations")
    return Response.json({ id: `benchmark-conversation-${process.pid}-${++nextResponse}` });
  if (url.pathname === "/v1/responses") {
    const request = JSON.parse(String(init.body)) as { stream?: boolean };
    if (request.stream) throw new Error("HTTP benchmark expects a non-stream AI turn");
    await new Promise((resolve) => setTimeout(resolve, 150));
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
  if (message === "metrics")
    process.send?.({ metrics: { pid: process.pid, rssBytes: process.memoryUsage().rss,
      cpu: process.cpuUsage() } });
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
