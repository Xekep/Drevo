import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
const [release, dataPath] = process.argv.slice(2);
if (!release || !dataPath || !/^drevo_preflight_[a-f0-9]+$/.test(process.env.PGDATABASE || ""))
  throw new Error("Expected an isolated preflight database");
const { startServer } = await import(pathToFileURL(join(resolve(release), "src/server/index.ts")).href);
const app = await startServer(0, dataPath, true);
try {
  if (app.archive.db.kind !== "postgres") throw new Error("Release did not use PostgreSQL");
  const before = await app.archive.read();
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/health`);
  const health = await response.json();
  if (!response.ok || !health.ok || health.revision !== before.revision)
    throw new Error("PostgreSQL health check failed");
  const after = await app.archive.read();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Startup changed archive data");
  console.log("PostgreSQL runtime and archive read verified on restored copy");
} finally { await app.close(); }
