import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type Descriptor = { id: string; personId: string; descriptor: number[] };
const [databasePath, inputPath] = process.argv.slice(2);
if (!databasePath || !inputPath)
  throw new Error(
    "Usage: import-face-descriptors <database.sqlite> <descriptors.json>",
  );
const values: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
if (!Array.isArray(values))
  throw new Error("Expected an array of face descriptors");
const descriptors = values.filter(
  (value): value is Descriptor =>
    !!value &&
    typeof value === "object" &&
    typeof (value as Descriptor).id === "string" &&
    typeof (value as Descriptor).personId === "string" &&
    Array.isArray((value as Descriptor).descriptor) &&
    (value as Descriptor).descriptor.length === 128 &&
    (value as Descriptor).descriptor.every(Number.isFinite),
);
if (descriptors.length !== values.length)
  throw new Error("Invalid face descriptor input");

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS face_descriptors (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      data TEXT NOT NULL CHECK(json_valid(data)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS face_descriptors_person ON face_descriptors(person_id);
    PRAGMA user_version=3;
  `);
  const person = db.prepare("SELECT 1 FROM people WHERE id=?");
  const insert = db.prepare(
    "INSERT OR IGNORE INTO face_descriptors(id,person_id,data) VALUES(?,?,?)",
  );
  let inserted = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const value of descriptors) {
      if (!person.get(value.personId))
        throw new Error(`Unknown person: ${value.personId}`);
      if (
        insert.run(value.id, value.personId, JSON.stringify(value.descriptor))
          .changes
      )
        inserted++;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ received: descriptors.length, inserted }));
} finally {
  db.close();
}
