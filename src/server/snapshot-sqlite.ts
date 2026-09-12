import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error(
    "Usage: snapshot-sqlite <source.sqlite> <destination.sqlite>",
  );
mkdirSync(dirname(destination), { recursive: true });
const db = new DatabaseSync(source);
try {
  db.prepare("VACUUM INTO ?").run(destination);
} finally {
  db.close();
}
