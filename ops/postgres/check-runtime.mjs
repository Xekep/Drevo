import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
const [release, dataPath, testMode] = process.argv.slice(2);
const isolatedDatabase = /^drevo_preflight_[a-f0-9]+$/.test(process.env.PGDATABASE || "") ||
  (testMode === "--test-migration-runtime" &&
    /^drevo_migration_runtime_[a-z0-9_]+$/.test(process.env.PGDATABASE || ""));
if (!release || !dataPath || !isolatedDatabase ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{2,63}$/.test(process.env.ARCHIVE_ID || ""))
  throw new Error("Expected an isolated preflight database");
const { startServer } = await import(pathToFileURL(join(resolve(release), "src/server/index.ts")).href);
let providerCalls = 0;
const denyProvider = () => {
  providerCalls++;
  throw new Error("Provider HTTP is forbidden during preflight");
};
const app = await startServer(0, dataPath, true, undefined, denyProvider, process.env.ARCHIVE_ID);
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
if (providerCalls !== 0) throw new Error("Provider HTTP was attempted during preflight");
console.log("Provider HTTP calls during preflight: 0");
