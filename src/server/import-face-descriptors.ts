import {
  openPostgresDatabase,
  storeDatabase,
  configuredDatabaseBackend,
} from "./store-database.ts";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { importFaceDescriptors } from "./face-descriptor-import.ts";
import { initializeArchiveSchema } from "./schema.ts";

const [databasePath, inputPath] = process.argv.slice(2);
if (!databasePath || !inputPath)
  throw new Error(
    "Usage: import-face-descriptors <database.sqlite> <descriptors.json>",
  );
const values: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
const db =
  configuredDatabaseBackend(databasePath) === "postgres"
    ? await openPostgresDatabase(process.env.ARCHIVE_ID || "", databasePath)
    : (() => {
        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        initializeArchiveSchema(sqlite);
        return storeDatabase(sqlite);
      })();
try {
  console.log(
    JSON.stringify(await importFaceDescriptors(storeDatabase(db), values)),
  );
} finally {
  await db.close();
}
