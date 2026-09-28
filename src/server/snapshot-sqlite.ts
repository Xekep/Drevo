import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configuredDatabaseBackend } from "./store-database.ts";

const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error(
    "Usage: snapshot-sqlite <source.sqlite> <destination.sqlite>",
  );
mkdirSync(dirname(destination), { recursive: true });
if (configuredDatabaseBackend(source) !== "sqlite")
  throw new Error(
    "Для PostgreSQL используйте pg_dump или полный бэкап Drevo, а не снимок старой SQLite.",
  );
const db = new DatabaseSync(source);
try {
  db.prepare("VACUUM INTO ?").run(destination);
} finally {
  db.close();
}
