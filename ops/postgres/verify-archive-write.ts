import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { openArchive } from "../../src/server/database.ts";
import { ConflictError } from "../../src/server/archive-errors.ts";
import { readPostgresArchiveInTransaction } from "../../src/server/postgres-archive-read.ts";
import { exportGedcom, importGedcom } from "../../src/domain/gedcom.ts";
import type { Family, Person } from "../../src/domain/index.ts";
import { writeArchiveRevisionForParity } from "./write-archive-parity.ts";

type DependentCounts = {
  documents: number;
  documentLinks: number;
  comments: number;
  linkedDocuments: number;
  linkedComments: number;
};

async function dependentCounts(
  sqlite: DatabaseSync,
  client: pg.Client,
  archiveId: string,
  personId: string,
): Promise<DependentCounts> {
  const local = sqlite
    .prepare(
      `SELECT
    (SELECT count(*) FROM documents) AS documents,
    (SELECT count(*) FROM document_people) AS document_links,
    (SELECT count(*) FROM person_comments) AS comments,
    (SELECT count(*) FROM document_people WHERE person_id=?) AS linked_documents,
    (SELECT count(*) FROM person_comments WHERE person_id=?) AS linked_comments`,
    )
    .get(personId, personId)!;
  const remote = (
    await client.query(
      `SELECT
    (SELECT count(*) FROM documents WHERE archive_id=$1) AS documents,
    (SELECT count(*) FROM document_people WHERE archive_id=$1) AS document_links,
    (SELECT count(*) FROM person_comments WHERE archive_id=$1) AS comments,
    (SELECT count(*) FROM document_people WHERE archive_id=$1 AND person_id=$2) AS linked_documents,
    (SELECT count(*) FROM person_comments WHERE archive_id=$1 AND person_id=$2) AS linked_comments`,
      [archiveId, personId],
    )
  ).rows[0];
  const read = (row: Record<string, unknown>): DependentCounts => ({
    documents: Number(row.documents),
    documentLinks: Number(row.document_links),
    comments: Number(row.comments),
    linkedDocuments: Number(row.linked_documents),
    linkedComments: Number(row.linked_comments),
  });
  const result = read(local);
  assert.deepStrictEqual(read(remote), result);
  return result;
}

/** Rehearses writes against a copied SQLite and rolls every PostgreSQL change back. */
export async function verifyArchiveWrite(
  sqlitePath: string,
  archiveId: string,
  client: pg.Client,
) {
  if (basename(sqlitePath) === "drevo.sqlite")
    throw new Error("Используйте согласованную копию SQLite, а не рабочую БД");
  const databaseName = String(
    (await client.query("SELECT current_database() AS name")).rows[0]?.name ||
      "",
  );
  if (!/^drevo_migration(?:_|$)/.test(databaseName))
    throw new Error(
      "Репетиция записи разрешена только в изолированной migration-базе",
    );
  const directory = mkdtempSync(join(tmpdir(), "drevo-pg-write-"));
  const copy = join(directory, "rehearsal.sqlite");
  let sqlite: ReturnType<typeof openArchive> | undefined;
  let dependentDb: DatabaseSync | undefined;
  let transaction = false;
  try {
    copyFileSync(sqlitePath, copy);
    sqlite = openArchive(copy, {
      title: "",
      description: "",
      demo: false,
      people: [],
      links: [],
      photos: [],
    });
    dependentDb = new DatabaseSync(copy);
    dependentDb.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    await client.query("BEGIN");
    transaction = true;
    const source = sqlite.read();
    assert.deepStrictEqual(
      await readPostgresArchiveInTransaction(client, archiveId),
      source,
    );

    const marker = randomUUID();
    const beforeDependents = await dependentCounts(
      dependentDb,
      client,
      archiveId,
      marker,
    );
    const draft = structuredClone(source.family);
    draft.title = `${draft.title} · проверка ${marker.slice(0, 8)}`;
    draft.people.reverse();
    const relationId = randomUUID();
    draft.links ??= [];
    draft.links.push({
      id: relationId,
      from: draft.people[0].id,
      to: marker,
      type: "godparent",
    });
    const tagId = randomUUID();
    if (draft.photos?.length) {
      draft.photos.reverse();
      draft.photos[0].description = `${draft.photos[0].description || ""} · проверка ${marker.slice(0, 8)}`;
      const taggedPhoto = draft.photos.find((photo) => photo.tags.length > 0);
      if (taggedPhoto) {
        taggedPhoto.tags.reverse();
        taggedPhoto.tags.push({
          ...taggedPhoto.tags[0],
          id: tagId,
          personId: marker,
        });
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
    const postgresFirst = await writeArchiveRevisionForParity(
      client,
      archiveId,
      draft,
      source.revision,
    );
    assert.deepStrictEqual(postgresFirst, first);
    assert.deepStrictEqual(
      await readPostgresArchiveInTransaction(client, archiveId),
      sqlite.read(),
    );
    assert.deepStrictEqual(
      await dependentCounts(dependentDb, client, archiveId, marker),
      beforeDependents,
    );

    // A new document stays in the archive after its sole person is removed;
    // the document association and discussion must cascade in both stores.
    const documentId = randomUUID();
    const fileName = `${documentId}.pdf`;
    const createdAt = new Date().toISOString();
    dependentDb
      .prepare(
        `INSERT INTO documents
      (id,title,title_search,file_name,file_size,uploaded_by,created_at)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        documentId,
        "Проверка",
        "проверка",
        fileName,
        1,
        "parity-check",
        createdAt,
      );
    dependentDb
      .prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)")
      .run(documentId, marker);
    dependentDb
      .prepare(
        "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,?,?,?)",
      )
      .run(marker, "parity-check", 1_000, "Проверка удаления");
    await client.query(
      `INSERT INTO documents
      (archive_id,id,ordinal,title,title_search,file_name,file_size,uploaded_by,created_at)
      VALUES($1,$2,(SELECT coalesce(max(ordinal),0)+1 FROM documents WHERE archive_id=$1),$3,$4,$5,$6,$7,$8)`,
      [
        archiveId,
        documentId,
        "Проверка",
        "проверка",
        fileName,
        1,
        "parity-check",
        createdAt,
      ],
    );
    await client.query(
      `INSERT INTO document_people(archive_id,ordinal,document_id,person_id)
      VALUES($1,(SELECT coalesce(max(ordinal),0)+1 FROM document_people WHERE archive_id=$1),$2,$3)`,
      [archiveId, documentId, marker],
    );
    await client.query(
      `INSERT INTO person_comments(archive_id,id,person_id,author_id,created_ms,text)
      VALUES($1,(SELECT coalesce(max(id),0)+1 FROM person_comments WHERE archive_id=$1),$2,$3,$4,$5)`,
      [archiveId, marker, "parity-check", 1_000, "Проверка удаления"],
    );
    const withDependents = await dependentCounts(
      dependentDb,
      client,
      archiveId,
      marker,
    );
    assert.deepStrictEqual(withDependents, {
      documents: beforeDependents.documents + 1,
      documentLinks: beforeDependents.documentLinks + 1,
      comments: beforeDependents.comments + 1,
      linkedDocuments: 1,
      linkedComments: 1,
    });

    const concurrent = new pg.Client({ connectionTimeoutMillis: 5000 });
    await concurrent.connect();
    try {
      await concurrent.query("BEGIN");
      await concurrent.query("SET LOCAL lock_timeout = '500ms'");
      await assert.rejects(
        writeArchiveRevisionForParity(
          concurrent,
          archiveId,
          draft,
          source.revision,
        ),
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
    const postgresSecond = await writeArchiveRevisionForParity(
      client,
      archiveId,
      updated,
      first.revision,
    );
    assert.deepStrictEqual(postgresSecond, second);
    assert.deepStrictEqual(
      await readPostgresArchiveInTransaction(client, archiveId),
      sqlite.read(),
    );
    assert.deepStrictEqual(
      await dependentCounts(dependentDb, client, archiveId, marker),
      {
        ...beforeDependents,
        documents: beforeDependents.documents + 1,
      },
    );

    const transfer = importGedcom(
      exportGedcom({
        ...second.family,
        people: [{ ...newPerson, id: randomUUID(), name: "Импорт" }],
        links: [],
        photos: [],
      }),
      randomUUID(),
    );
    assert.equal(transfer.family.people.length, 1);
    const imported: Family = {
      ...second.family,
      people: [...second.family.people, ...transfer.family.people],
      links: [...(second.family.links || []), ...(transfer.family.links || [])],
    };
    const third = sqlite.write(imported, second.revision);
    const postgresThird = await writeArchiveRevisionForParity(
      client,
      archiveId,
      imported,
      second.revision,
    );
    assert.deepStrictEqual(postgresThird, third);
    assert.deepStrictEqual(
      await readPostgresArchiveInTransaction(client, archiveId),
      sqlite.read(),
    );
    assert.equal(
      exportGedcom(postgresThird.family),
      exportGedcom(third.family),
    );

    assert.throws(() => sqlite!.write(updated, first.revision), ConflictError);
    await assert.rejects(
      writeArchiveRevisionForParity(client, archiveId, updated, first.revision),
      ConflictError,
    );
    await assert.rejects(
      writeArchiveRevisionForParity(
        client,
        "another-archive",
        updated,
        third.revision,
      ),
      /Архив не найден/,
    );
    await client.query("ROLLBACK");
    transaction = false;
    return {
      archiveId,
      startRevision: source.revision,
      testedRevisions: 3,
      concurrentLock: true,
      people: source.family.people.length,
      photos: source.family.photos?.length ?? 0,
    };
  } finally {
    if (transaction) await client.query("ROLLBACK");
    dependentDb?.close();
    sqlite?.close();
    for (const file of readdirSync(directory))
      unlinkSync(join(directory, file));
    rmdirSync(directory);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [sqlitePath, archiveId] = process.argv.slice(2);
  if (!sqlitePath || !archiveId)
    throw new Error(
      "Использование: verify-archive-write.ts <копия.sqlite> <archive_id>",
    );
  const client = new pg.Client({ connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    console.log(
      JSON.stringify(await verifyArchiveWrite(sqlitePath, archiveId, client)),
    );
  } finally {
    await client.end();
  }
}
