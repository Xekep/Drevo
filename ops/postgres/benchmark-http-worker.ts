import { startServer } from "../../src/server/index.ts";

if (process.env.DATABASE_BACKEND !== "postgres" ||
    !/^drevo_migration_bench_[a-z0-9_]+$/.test(process.env.PGDATABASE || ""))
  throw new Error("HTTP benchmark requires an isolated PostgreSQL database");

const app = await startServer(0, process.env.DREVO_BENCH_DATA_PATH, true);
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
