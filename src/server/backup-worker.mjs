// Isolated SQLite snapshot: VACUUM / integrity checks must not block HTTP requests.
import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
const [source, destination] = process.argv.slice(2);
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout=10000");
  db.prepare("VACUUM INTO ?").run(destination);
  chmodSync(destination, 0o600);
} finally {
  db.close();
}
const copy = new DatabaseSync(destination, { readOnly: true });
try {
  if (
    copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
    copy.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new Error("Backup database failed integrity validation");
} finally {
  copy.close();
}
