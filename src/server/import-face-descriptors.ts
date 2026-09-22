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
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
try {
  initializeArchiveSchema(db);
  console.log(JSON.stringify(importFaceDescriptors(db, values)));
} finally {
  db.close();
}
