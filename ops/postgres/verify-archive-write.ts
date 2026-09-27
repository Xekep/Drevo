import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { openArchive } from "../../src/server/database.ts";
import { ConflictError } from "../../src/server/archive-errors.ts";
import { readPostgresArchiveInTransaction } from "../../src/server/postgres-archive-read.ts";
import type { Family, Person } from "../../src/domain/index.ts";
import { writeArchiveRevisionForParity } from "./write-archive-parity.ts";

/** Rehearses writes against a copied SQLite and rolls every PostgreSQL change back. */
export async function verifyArchiveWrite(
  sqlitePath: string,
  archiveId: string,
  client: pg.Client,
) {
  if (basename(sqlitePath) === "drevo.sqlite")
    throw new Error("Используйте согласованную копию SQLite, а не рабочую БД");
  const databaseName = String((await client.query("SELECT current_database() AS name")).rows[0]?.name || "");
  if (!/^drevo_migration(?:_|$)/.test(databaseName))
    throw new Error("Репетиция записи разрешена только в изолированной migration-базе");
  const directory = mkdtempSync(join(tmpdir(), "drevo-pg-write-"));
  const copy = join(directory, "rehearsal.sqlite");
  let sqlite: ReturnType<typeof openArchive> | undefined;
  let transaction = false;
  try {
    copyFileSync(sqlitePath, copy);
    sqlite = openArchive(copy, { title: "", description: "", demo: false, people: [], links: [], photos: [] });
    await client.query("BEGIN");
    transaction = true;
    const source = sqlite.read();
    assert.deepStrictEqual(await readPostgresArchiveInTransaction(client, archiveId), source);

    const marker = randomUUID();
    const draft = structuredClone(source.family);
    draft.title = `${draft.title} · проверка ${marker.slice(0, 8)}`;
    draft.people.reverse();
    const relationId = randomUUID();
    draft.links ??= [];
    draft.links.push({ id: relationId, from: draft.people[0].id, to: marker, type: "godparent" });
    const tagId = randomUUID();
    if (draft.photos?.length) {
      draft.photos.reverse();
      draft.photos[0].description = `${draft.photos[0].description || ""} · проверка ${marker.slice(0, 8)}`;
      const taggedPhoto = draft.photos.find((photo) => photo.tags.length > 0);
      if (taggedPhoto) {
        taggedPhoto.tags.reverse();
        taggedPhoto.tags.push({ ...taggedPhoto.tags[0], id: tagId, personId: marker });
      }
    }
    const newPerson: Person = {
      id: marker,
      name: "Проверка",
      surname: "Миграции",
      patronymic: "",
      sex: "m",
      birth: "2000",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      column: 0,
      generation: 1,
    };
    draft.people.push(newPerson);
    const first = sqlite.write(draft, source.revision);
    const postgresFirst = await writeArchiveRevisionForParity(client, archiveId, draft, source.revision);
    assert.deepStrictEqual(postgresFirst, first);
    assert.deepStrictEqual(await readPostgresArchiveInTransaction(client, archiveId), sqlite.read());

    const concurrent = new pg.Client({ connectionTimeoutMillis: 5000 });
    await concurrent.connect();
    try {
      await concurrent.query("BEGIN");
      await concurrent.query("SET LOCAL lock_timeout = '500ms'");
      await assert.rejects(
        concurrent.query("SELECT revision FROM archives WHERE id=$1 FOR UPDATE", [archiveId]),
        (error: unknown) => (error as { code?: string }).code === "55P03",
      );
    } finally {
      await concurrent.query("ROLLBACK");
      await concurrent.end();
    }

    const updated: Family = structuredClone(first.family);
    updated.people = updated.people.filter((person) => person.id !== marker);
    updated.links = updated.links?.filter((link) => link.id !== relationId);
    for (const photo of updated.photos || [])
      photo.tags = photo.tags.filter((tag) => tag.id !== tagId);
    const second = sqlite.write(updated, first.revision);
    const postgresSecond = await writeArchiveRevisionForParity(client, archiveId, updated, first.revision);
    assert.deepStrictEqual(postgresSecond, second);
    assert.deepStrictEqual(await readPostgresArchiveInTransaction(client, archiveId), sqlite.read());

    assert.throws(() => sqlite!.write(updated, first.revision), ConflictError);
    await assert.rejects(
      writeArchiveRevisionForParity(client, archiveId, updated, first.revision),
      ConflictError,
    );
    await assert.rejects(
      writeArchiveRevisionForParity(client, "another-archive", updated, second.revision),
      /Архив не найден/,
    );
    await client.query("ROLLBACK");
    transaction = false;
    return { archiveId, startRevision: source.revision, testedRevisions: 2, concurrentLock: true, people: source.family.people.length, photos: source.family.photos?.length ?? 0 };
  } finally {
    if (transaction) await client.query("ROLLBACK");
    sqlite?.close();
    for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
    rmdirSync(directory);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sqlitePath, archiveId] = process.argv.slice(2);
  if (!sqlitePath || !archiveId)
    throw new Error("Использование: verify-archive-write.ts <копия.sqlite> <archive_id>");
  const client = new pg.Client({ connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    console.log(JSON.stringify(await verifyArchiveWrite(sqlitePath, archiveId, client)));
  } finally {
    await client.end();
  }
}
