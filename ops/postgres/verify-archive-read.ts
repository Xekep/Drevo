import { storeDatabase } from "../../src/server/store-database.ts";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { readArchive } from "../../src/server/database.ts";
import { readPostgresArchive } from "../../src/server/postgres-archive-read.ts";

export async function verifyArchiveRead(
  sqlitePath: string,
  archiveId: string,
  client: pg.Client,
) {
  if (basename(sqlitePath) === "drevo.sqlite")
    throw new Error("Используйте согласованную копию SQLite, а не рабочую БД");
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (
      sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    )
      throw new Error("Копия SQLite повреждена");
    const source = await readArchive(storeDatabase(sqlite));
    const imported = await readPostgresArchive(client, archiveId);
    if (!isDeepStrictEqual(imported, source))
      throw new Error("Семейный граф PostgreSQL отличается от снимка SQLite");
    return {
      archiveId,
      revision: imported.revision,
      people: imported.family.people.length,
      relations:
        imported.family.people.reduce(
          (total, person) => total + person.parents.length,
          0,
        ) +
        imported.family.people.reduce(
          (total, person) => total + person.spouses.length,
          0,
        ) /
          2 +
        (imported.family.links?.length ?? 0),
      photos: imported.family.photos?.length ?? 0,
    };
  } finally {
    sqlite.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [sqlitePath, archiveId] = process.argv.slice(2);
  if (!sqlitePath || !archiveId)
    throw new Error(
      "Использование: verify-archive-read.ts <копия.sqlite> <archive_id>",
    );
  const client = new pg.Client({ connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    console.log(
      JSON.stringify(await verifyArchiveRead(sqlitePath, archiveId, client)),
    );
  } finally {
    await client.end();
  }
}
