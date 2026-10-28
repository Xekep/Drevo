import type { StoreDatabase } from "./store-database.ts";
import type {
  ArchiveRows,
  JsonRow,
  RelationRow,
  TagRow,
  UnionRow,
} from "./archive-rows.ts";

async function syncJsonRows(
  db: StoreDatabase,
  table: "people" | "photos",
  before: JsonRow[],
  after: JsonRow[],
  deleteRemoved = true,
) {
  const previous = new Map(before.map((row) => [row.id, row.data]));
  const nextIds = new Set(after.map((row) => row.id));
  const insert = db.prepare(
      `INSERT INTO ${table}(id,data) VALUES(?,?)`,
      `INSERT INTO ${table}(id,data) VALUES(?,?)`,
    ),
    update = db.prepare(
      `UPDATE ${table} SET data=? WHERE id=?`,
      `UPDATE ${table} SET data=? WHERE id=?`,
    ),
    remove = db.prepare(
      `DELETE FROM ${table} WHERE id=?`,
      `DELETE FROM ${table} WHERE id=?`,
    );
  for (const row of after) {
    if (!previous.has(row.id)) await insert.run(row.id, row.data);
    else if (previous.get(row.id) !== row.data)
      await update.run(row.data, row.id);
  }
  if (deleteRemoved)
    for (const row of before)
      if (!nextIds.has(row.id)) await remove.run(row.id);
}

async function syncRelations(
  db: StoreDatabase,
  before: RelationRow[],
  after: RelationRow[],
) {
  const previous = new Map(before.map((row) => [row.id, row])),
    following = new Map(after.map((row) => [row.id, row])),
    remove = db.prepare(
      "DELETE FROM relations WHERE id=?",
      "DELETE FROM relations WHERE id=?",
    ),
    insert = db.prepare(
      "INSERT INTO relations(id,source,target,type,note,twin_kind,created_by,sources,confidence) VALUES(?,?,?,?,?,?,?,?,?)",
      "INSERT INTO relations(id,source,target,type,note,twin_kind,created_by,sources,confidence) VALUES(?,?,?,?,?,?,?,?,?)",
    ),
    update = db.prepare(
      "UPDATE relations SET note=?,twin_kind=?,created_by=?,sources=?,confidence=? WHERE id=?",
      "UPDATE relations SET note=?,twin_kind=?,created_by=?,sources=?,confidence=? WHERE id=?",
    );
  for (const row of before) {
    const next = following.get(row.id);
    if (
      !next ||
      next.source !== row.source ||
      next.target !== row.target ||
      next.type !== row.type
    )
      await remove.run(row.id);
  }
  for (const row of after) {
    const old = previous.get(row.id);
    if (
      !old ||
      old.source !== row.source ||
      old.target !== row.target ||
      old.type !== row.type
    )
      await insert.run(
        row.id,
        row.source,
        row.target,
        row.type,
        row.note,
        row.twinKind,
        row.createdBy,
        row.sources,
        row.confidence,
      );
    else if (
      old.note !== row.note ||
      old.twinKind !== row.twinKind ||
      old.createdBy !== row.createdBy ||
      old.sources !== row.sources ||
      old.confidence !== row.confidence
    )
      await update.run(
        row.note,
        row.twinKind,
        row.createdBy,
        row.sources,
        row.confidence,
        row.id,
      );
  }
}

async function syncTags(db: StoreDatabase, before: TagRow[], after: TagRow[]) {
  const previous = new Map(before.map((row) => [row.id, row])),
    nextIds = new Set(after.map((row) => row.id)),
    remove = db.prepare(
      "DELETE FROM photo_tags WHERE id=?",
      "DELETE FROM photo_tags WHERE id=?",
    ),
    insert = db.prepare(
      "INSERT INTO photo_tags(id,photo_id,person_id,data) VALUES(?,?,?,?)",
      "INSERT INTO photo_tags(id,photo_id,person_id,data) VALUES(?,?,?,?)",
    ),
    update = db.prepare(
      "UPDATE photo_tags SET photo_id=?,person_id=?,data=? WHERE id=?",
      "UPDATE photo_tags SET photo_id=?,person_id=?,data=? WHERE id=?",
    );
  for (const row of before) if (!nextIds.has(row.id)) await remove.run(row.id);
  for (const row of after) {
    const old = previous.get(row.id);
    if (!old) await insert.run(row.id, row.photoId, row.personId, row.data);
    else if (
      old.photoId !== row.photoId ||
      old.personId !== row.personId ||
      old.data !== row.data
    )
      await update.run(row.photoId, row.personId, row.data, row.id);
  }
}

async function syncUnions(
  db: StoreDatabase,
  before: UnionRow[],
  after: UnionRow[],
) {
  const old = new Map(before.map((row) => [row.id, row]));
  const next = new Set(after.map((row) => row.id));
  const remove = db.prepare(
    "DELETE FROM family_unions WHERE id=?",
    "DELETE FROM family_unions WHERE id=?",
  );
  const insert = db.prepare(
    "INSERT INTO family_unions(id,participant_a,participant_b,data) VALUES(?,?,?,?)",
    "INSERT INTO family_unions(id,participant_a,participant_b,data) VALUES(?,?,?,?)",
  );
  const update = db.prepare(
    "UPDATE family_unions SET participant_a=?,participant_b=?,data=? WHERE id=?",
    "UPDATE family_unions SET participant_a=?,participant_b=?,data=? WHERE id=?",
  );
  for (const row of before) if (!next.has(row.id)) await remove.run(row.id);
  for (const row of after) {
    const prior = old.get(row.id);
    if (!prior)
      await insert.run(row.id, row.participantA, row.participantB, row.data);
    else if (
      prior.participantA !== row.participantA ||
      prior.participantB !== row.participantB ||
      prior.data !== row.data
    )
      await update.run(row.participantA, row.participantB, row.data, row.id);
  }
}

export async function syncArchiveRows(
  db: StoreDatabase,
  before: ArchiveRows,
  after: ArchiveRows,
  options: { partialPhotos?: boolean } = {},
) {
  // Сначала создаём новые основные сущности, чтобы связи могли ссылаться на них.
  // Удаление старых people/photos откладываем до обновления зависимых строк.
  await syncJsonRows(db, "people", before.people, after.people, false);
  await syncJsonRows(db, "photos", before.photos, after.photos, false);
  await syncRelations(db, before.relations, after.relations);
  await syncUnions(db, before.unions, after.unions);
  await syncTags(db, before.tags, after.tags);

  const nextPhotoIds = new Set(after.photos.map((row) => row.id)),
    nextPeopleIds = new Set(after.people.map((row) => row.id)),
    removePhoto = db.prepare(
      "DELETE FROM photos WHERE id=?",
      "DELETE FROM photos WHERE id=?",
    ),
    removePerson = db.prepare(
      "DELETE FROM people WHERE id=?",
      "DELETE FROM people WHERE id=?",
    );
  for (const row of before.photos)
    if (!nextPhotoIds.has(row.id)) await removePhoto.run(row.id);
  if (before.photos.some((row) => !nextPhotoIds.has(row.id)))
    await db.exec(
      "DELETE FROM face_descriptors WHERE source_photo_id IS NOT NULL AND source_photo_id NOT IN (SELECT id FROM photos)",
      "DELETE FROM face_descriptors WHERE source_photo_id IS NOT NULL AND source_photo_id NOT IN (SELECT id FROM photos)",
    );
  for (const row of before.people)
    if (!nextPeopleIds.has(row.id)) await removePerson.run(row.id);
  const restoreOrder = async (
    table: "people" | "relations" | "family_unions" | "photos" | "photo_tags",
    beforeRows: Array<{ id: string }>,
    rows: Array<{ id: string }>,
  ) => {
    if (
      beforeRows.length === rows.length &&
      beforeRows.every((row, index) => row.id === rows[index]?.id)
    )
      return;
    const current = await db
      .prepare(
        `SELECT id,rowid AS position FROM ${table}`,
        `SELECT id,ordinal AS position FROM ${table}`,
      )
      .all();
    const positions = new Map(
      current.map((row) => [String(row.id), Number(row.position)]),
    );
    const moved = rows.flatMap((row, index) =>
      positions.get(row.id) === index + 1
        ? []
        : [{ id: row.id, position: index + 1 }],
    );
    if (!moved.length) return;
    const value = JSON.stringify(moved);
    // Two set operations retain the previous order semantics without 2*N
    // network round trips. The temporary negative range avoids UNIQUE clashes.
    for (const sign of [-1, 1])
      await db
        .prepare(
          `WITH moves AS (SELECT json_extract(value,'$.id') AS id,
          json_extract(value,'$.position') AS position FROM json_each(?))
          UPDATE ${table} SET rowid=${sign}*(SELECT position FROM moves WHERE moves.id=${table}.id)
          WHERE id IN (SELECT id FROM moves)`,
          `UPDATE ${table} t SET ordinal=${sign}*m.position
          FROM jsonb_to_recordset(?::jsonb) m(id text,position bigint)
          WHERE t.id=m.id`,
        )
        .run(value);
  };
  await restoreOrder("people", before.people, after.people);
  await restoreOrder("relations", before.relations, after.relations);
  await restoreOrder("family_unions", before.unions, after.unions);
  if (!options.partialPhotos) {
    await restoreOrder("photos", before.photos, after.photos);
    await restoreOrder("photo_tags", before.tags, after.tags);
  }
}
