import { authorizeArchive } from "./permissions.ts";
import { assertCurrentArchiveActor } from "./users.ts";
import { authorizeMediaReferences } from "./media-access.ts";
import {
  enforcePostgresMediaQuota,
  releaseAttachedMediaGrants,
} from "./postgres-media-quota.ts";
import type { ArchiveUser } from "../domain/access.ts";
import { DatabaseSync } from "node:sqlite";
import {
  storeDatabase,
  configuredDatabaseBackend,
  openPostgresDatabase,
  type StoreDatabase,
} from "./store-database.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { auditStore } from "./audit.ts";
import {
  archiveRows,
  type ArchiveRows,
  type JsonRow,
  type RelationRow,
  type TagRow,
} from "./archive-rows.ts";
import { initializeArchiveSchema } from "./schema.ts";
import { ConflictError } from "./archive-errors.ts";
import { patchPeople } from "./person-patches.ts";
import { archiveSnapshotReader } from "./archive-read-cache.ts";
import { hydrateArchive, hydrateRelations } from "./archive-hydration.ts";
import { applyArchiveChanges } from "../domain/changes.ts";
import {
  validateFamily,
  type Family,
  type Person,
  type ArchivePhoto,
} from "../domain/index.ts";

export { ConflictError } from "./archive-errors.ts";
export type StoredFaceDescriptor = {
  id: string;
  personId: string;
  data: string;
  createdBy?: string;
  sourcePhotoId?: string;
  sourceTagId?: string;
  model: string;
};

function addsMediaReference(before: Family, after: Family) {
  const existing = new Set([
    ...before.people.map((person) => person.photo),
    ...(before.photos || []).map((photo) => photo.url),
  ]);
  return (
    after.people.some(
      (person) => person.photo && !existing.has(person.photo),
    ) || (after.photos || []).some((photo) => !existing.has(photo.url))
  );
}

async function replaceArchiveRows(db: StoreDatabase, rows: ArchiveRows) {
  await db.exec(
    "DELETE FROM photo_tags; DELETE FROM photos; DELETE FROM relations; DELETE FROM people;",
    "DELETE FROM photo_tags; DELETE FROM photos; DELETE FROM relations; DELETE FROM people;",
  );
  const personQuery = db.prepare(
    "INSERT INTO people(id,data) VALUES(?,?)",
    "INSERT INTO people(id,data) VALUES(?,?)",
  );
  for (const row of rows.people) await personQuery.run(row.id, row.data);

  const relationQuery = db.prepare(
    "INSERT INTO relations(id,source,target,type,note,created_by) VALUES(?,?,?,?,?,?)",
    "INSERT INTO relations(id,source,target,type,note,created_by) VALUES(?,?,?,?,?,?)",
  );
  for (const row of rows.relations)
    await relationQuery.run(
      row.id,
      row.source,
      row.target,
      row.type,
      row.note,
      row.createdBy,
    );

  const photoQuery = db.prepare(
      "INSERT INTO photos(id,data) VALUES(?,?)",
      "INSERT INTO photos(id,data) VALUES(?,?)",
    ),
    tagQuery = db.prepare(
      "INSERT INTO photo_tags(id,photo_id,person_id,data) VALUES(?,?,?,?)",
      "INSERT INTO photo_tags(id,photo_id,person_id,data) VALUES(?,?,?,?)",
    );
  for (const row of rows.photos) await photoQuery.run(row.id, row.data);
  for (const row of rows.tags)
    await tagQuery.run(row.id, row.photoId, row.personId, row.data);
}

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
      "INSERT INTO relations(id,source,target,type,note,created_by) VALUES(?,?,?,?,?,?)",
      "INSERT INTO relations(id,source,target,type,note,created_by) VALUES(?,?,?,?,?,?)",
    ),
    update = db.prepare(
      "UPDATE relations SET note=?,created_by=? WHERE id=?",
      "UPDATE relations SET note=?,created_by=? WHERE id=?",
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
        row.createdBy,
      );
    else if (old.note !== row.note || old.createdBy !== row.createdBy)
      await update.run(row.note, row.createdBy, row.id);
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

async function syncArchiveRows(
  db: StoreDatabase,
  before: ArchiveRows,
  after: ArchiveRows,
) {
  // Сначала создаём новые основные сущности, чтобы связи могли ссылаться на них.
  // Удаление старых people/photos откладываем до обновления зависимых строк.
  await syncJsonRows(db, "people", before.people, after.people, false);
  await syncJsonRows(db, "photos", before.photos, after.photos, false);
  await syncRelations(db, before.relations, after.relations);
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
  await db.exec(
    "DELETE FROM face_descriptors WHERE source_photo_id IS NOT NULL AND source_photo_id NOT IN (SELECT id FROM photos)",
    "DELETE FROM face_descriptors WHERE source_photo_id IS NOT NULL AND source_photo_id NOT IN (SELECT id FROM photos)",
  );
  for (const row of before.people)
    if (!nextPeopleIds.has(row.id)) await removePerson.run(row.id);
  const restoreOrder = async (
    table: "people" | "relations" | "photos" | "photo_tags",
    beforeRows: Array<{ id: string }>,
    rows: Array<{ id: string }>,
  ) => {
    if (
      beforeRows.length === rows.length &&
      beforeRows.every((row, index) => row.id === rows[index]?.id)
    )
      return;
    const move = db.prepare(
      `UPDATE ${table} SET rowid=? WHERE id=?`,
      `UPDATE ${table} SET ordinal=? WHERE id=?`,
    );
    for (const [index, row] of rows.entries())
      await move.run(-(index + 1), row.id);
    for (const [index, row] of rows.entries())
      await move.run(index + 1, row.id);
  };
  await restoreOrder("people", before.people, after.people);
  await restoreOrder("relations", before.relations, after.relations);
  await restoreOrder("photos", before.photos, after.photos);
  await restoreOrder("photo_tags", before.tags, after.tags);
}

export async function openArchive(path: string, seed: Family) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  let db: StoreDatabase;
  if (configuredDatabaseBackend(path) === "postgres" && path !== ":memory:") {
    db = await openPostgresDatabase(process.env.ARCHIVE_ID || "", path);
  } else {
    const sqlite = new DatabaseSync(path);
    try {
      initializeArchiveSchema(sqlite);
    } catch (error) {
      sqlite.close();
      throw error;
    }
    db = storeDatabase(sqlite);
  }

  const audit = auditStore(db);
  const read = archiveSnapshotReader(db, () =>
      db.transaction(() => readArchive(db), true),
    ),
    meta = async () => await readArchiveMeta(db),
    portraitOverview = archiveSnapshotReader(db, () =>
      db.transaction(() => readArchiveOverview(db, true), true),
    ),
    anonymousOverview = archiveSnapshotReader(db, () =>
      db.transaction(() => readArchiveOverview(db, false), true),
    ),
    overview = (includePortraits = true) =>
      includePortraits ? portraitOverview() : anonymousOverview(),
    peoplePage = async (offset: number, limit: number) =>
      await readPeoplePage(db, offset, limit),
    photoPage = async (offset: number, limit: number) =>
      await db.transaction(() => readPhotoPage(db, offset, limit), true);

  const checkRevision = async (expected: number) => {
    const old = await db
      .prepare(
        "SELECT revision FROM archive WHERE id=1",
        "SELECT revision FROM archives WHERE id=current_setting('drevo.archive_id', true)",
      )
      .get();
    if (old && Number(old.revision) !== expected)
      throw new ConflictError(
        "Архив изменён в другой вкладке. Обновите данные перед сохранением.",
      );
    return old ? Number(old.revision) : null;
  };
  const remember = async (
    previous: Family,
    family: Family,
    revision: number,
    actor?: ArchiveUser,
    operation?: string,
  ) => {
    await db
      .prepare(
        "INSERT OR REPLACE INTO history(revision,data) VALUES(?,?)",
        "INSERT INTO history(revision,data) VALUES(?,?) ON CONFLICT(archive_id,revision) DO UPDATE SET data=excluded.data",
      )
      .run(revision, JSON.stringify(previous));
    await audit.archive(previous, family, actor, revision + 1);
    if (operation)
      await audit.record(
        {
          action: operation,
          entity: "archive",
          entityId: "archive",
          label: "Семейный архив",
          personIds: [],
          details: [],
        },
        actor,
        revision + 1,
      );
  };
  const finishWrite = async () =>
    await db.exec(
      "DELETE FROM history WHERE revision NOT IN (SELECT revision FROM history ORDER BY revision DESC LIMIT 50);",
      "DELETE FROM history WHERE revision NOT IN (SELECT revision FROM history ORDER BY revision DESC LIMIT 50);",
    );

  async function write(
    value: unknown,
    expected: number,
    actor?: ArchiveUser,
    operation?: string,
    knownPrevious?: Family,
    faceDescriptors?: StoredFaceDescriptor[],
    afterWrite?: (db: StoreDatabase) => void | Promise<void>,
  ) {
    return await db.transaction(async () => {
      const oldRevision = await checkRevision(expected);
      if (actor) await assertCurrentArchiveActor(db, actor);
      const previous =
        oldRevision === null ? null : knownPrevious || (await read()).family;
      const family =
        actor && previous
          ? authorizeArchive(value, previous, actor)
          : validateFamily(value);
      if (actor && previous)
        await authorizeMediaReferences(db, previous, family, actor);
      if (previous && oldRevision !== null)
        await remember(previous, family, oldRevision, actor, operation);

      const nextRows = archiveRows(family);
      if (!previous) await replaceArchiveRows(db, nextRows);
      else {
        const previousRows = archiveRows(previous);
        await syncArchiveRows(db, previousRows, nextRows);
      }

      await db
        .prepare(
          "INSERT INTO archive VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,demo=excluded.demo,revision=excluded.revision",
          "UPDATE archives SET title=?,description=?,demo=(?::integer<>0),revision=? WHERE id=current_setting('drevo.archive_id', true)",
        )
        .run(
          family.title,
          family.description,
          Number(family.demo),
          expected + 1,
        );
      if (faceDescriptors) {
        await db.exec(
          "DELETE FROM face_descriptors",
          "DELETE FROM face_descriptors",
        );
        const insert = db.prepare(
          `INSERT INTO face_descriptors
             (id,person_id,data,created_by,source_photo_id,source_tag_id,model)
           VALUES(?,?,?,?,?,?,?)`,
          "INSERT INTO face_descriptors\n             (id,person_id,data,created_by,source_photo_id,source_tag_id,model)\n           VALUES(?,?,?,?,?,?,?)",
        );
        for (const sample of faceDescriptors)
          await insert.run(
            sample.id,
            sample.personId,
            sample.data,
            sample.createdBy || null,
            sample.sourcePhotoId || null,
            sample.sourceTagId || null,
            sample.model,
          );
      }
      await afterWrite?.(db);
      if (actor && previous && addsMediaReference(previous, family)) {
        await releaseAttachedMediaGrants(db);
        await enforcePostgresMediaQuota(db);
      }
      await finishWrite();
      return { family, revision: expected + 1 };
    });
  }

  async function appendPhoto(
    value: ArchivePhoto,
    expected: number,
    actor: ArchiveUser,
  ) {
    return await db.transaction(async () => {
      const oldRevision = await checkRevision(expected);
      await assertCurrentArchiveActor(db, actor);
      if (oldRevision === null) throw new ConflictError("Архив ещё не создан");
      const previous = (await read()).family;
      const family = authorizeArchive(
        {
          ...previous,
          photos: [...(previous.photos || []), value],
        },
        previous,
        actor,
      );
      const photo = family.photos!.find((item) => item.id === value.id)!;
      await authorizeMediaReferences(db, previous, family, actor);
      await remember(previous, family, oldRevision, actor);
      await db
        .prepare(
          "INSERT INTO photos(id,data) VALUES(?,?)",
          "INSERT INTO photos(id,data) VALUES(?,?)",
        )
        .run(photo.id, JSON.stringify({ ...photo, tags: undefined }));
      const tagQuery = db.prepare(
        "INSERT INTO photo_tags(id,photo_id,person_id,data) VALUES(?,?,?,?)",
        "INSERT INTO photo_tags(id,photo_id,person_id,data) VALUES(?,?,?,?)",
      );
      for (const tag of photo.tags)
        await tagQuery.run(
          `${photo.id}:${tag.id}`,
          photo.id,
          tag.personId,
          JSON.stringify(tag),
        );
      await db
        .prepare(
          "UPDATE archive SET revision=? WHERE id=1",
          "UPDATE archives SET revision=? WHERE id=current_setting('drevo.archive_id', true)",
        )
        .run(expected + 1);
      await releaseAttachedMediaGrants(db);
      await enforcePostgresMediaQuota(db);
      await finishWrite();
      return { family, revision: expected + 1 };
    });
  }

  if (
    !(await db
      .prepare(
        "SELECT id FROM archive WHERE id=1",
        "SELECT id FROM archives WHERE id=current_setting('drevo.archive_id', true)",
      )
      .get())
  )
    await write(seed, 0);
  return {
    read,
    meta,
    overview,
    peoplePage,
    photoPage,
    write,
    patchPeople: async (
      changes: Parameters<typeof patchPeople>[1],
      expected: number,
      actor: ArchiveUser,
    ) => await patchPeople(db, changes, expected, actor),
    async readRevision(revision: number) {
      const current = await read();
      if (revision === current.revision) return current.family;
      if (
        !Number.isInteger(revision) ||
        revision < 0 ||
        revision > current.revision
      )
        throw new Error("Некорректная версия архива");
      let family = current.family,
        nextRevision = current.revision;
      for (const row of await db
        .prepare(
          "SELECT revision,data FROM history WHERE revision>=? ORDER BY revision DESC",
          "SELECT revision,data FROM history WHERE revision>=? ORDER BY revision DESC",
        )
        .all(revision)) {
        if (Number(row.revision) !== nextRevision - 1)
          throw new Error("Версия больше не хранится в истории");
        const saved = JSON.parse(String(row.data));
        family =
          saved.format === "drevo-person-patches-v1"
            ? applyArchiveChanges(family, saved.changes, "local").family
            : saved;
        nextRevision--;
      }
      if (nextRevision !== revision)
        throw new Error("Версия больше не хранится в истории");
      return validateFamily(family);
    },
    appendPhoto,
    close: async () => await db.close(),
    db,
  };
}

async function readArchiveMeta(db: StoreDatabase) {
  const meta = (await db
    .prepare(
      `SELECT archive.*,
        (SELECT count(*) FROM people) AS people_count,
        (SELECT count(*) FROM photos) AS photos_count
       FROM archive WHERE id=1`,
      "SELECT archives.*,\n        (SELECT count(*) FROM people) AS people_count,\n        (SELECT count(*) FROM photos) AS photos_count\n       FROM archives WHERE id=current_setting('drevo.archive_id', true)",
    )
    .get())!;
  return {
    title: String(meta.title),
    description: String(meta.description),
    demo: !!meta.demo,
    revision: Number(meta.revision),
    people: Number(meta.people_count),
    photos: Number(meta.photos_count),
  };
}

/**
 * Начальная проекция для ReactFlow: весь родственный граф, но без фотографий,
 * источников, биографий, наград и событий. Тяжёлые JSON-поля отбрасывает сам
 * SQLite до передачи строки в Node.
 */
async function readArchiveOverview(db: StoreDatabase, includePortraits = true) {
  const meta = await readArchiveMeta(db);
  const remove = [
    "$.sources",
    "$.biography",
    "$.occupation",
    "$.awards",
    "$.events",
    ...(includePortraits ? [] : ["$.photo"]),
  ];
  const placeholders = remove.map(() => "?").join(", ");
  const people = (
    await db
      .prepare(
        `SELECT json_set(json_remove(data, ${placeholders}), '$.sources', json('[]')) AS data
       FROM people ORDER BY rowid`,
        `SELECT (data - ARRAY[${remove.map(() => "substring(?::text FROM 3)").join(",")}]::text[]) || '{"sources":[]}'::jsonb AS data FROM people ORDER BY ordinal`,
      )
      .all(...remove)
  ).map(
    (row) =>
      ({
        ...JSON.parse(String(row.data)),
        parents: [],
        spouses: [],
      }) as Person,
  );
  const links = hydrateRelations(
    await db
      .prepare(
        "SELECT * FROM relations ORDER BY rowid",
        "SELECT * FROM relations ORDER BY ordinal",
      )
      .all(),
    people,
  );
  return {
    family: {
      title: meta.title,
      description: meta.description,
      demo: meta.demo,
      people,
      links,
      photos: [],
    } as Family,
    revision: meta.revision,
    totals: { people: meta.people, photos: meta.photos },
  };
}

async function readPeoplePage(
  db: StoreDatabase,
  offset: number,
  limit: number,
): Promise<Person[]> {
  return (
    await db
      .prepare(
        "SELECT data FROM people ORDER BY rowid LIMIT ? OFFSET ?",
        "SELECT data FROM people ORDER BY ordinal LIMIT ? OFFSET ?",
      )
      .all(limit, offset)
  ).map(
    (row) =>
      ({
        ...JSON.parse(String(row.data)),
        parents: [],
        spouses: [],
      }) as Person,
  );
}

async function readPhotoPage(
  db: StoreDatabase,
  offset: number,
  limit: number,
): Promise<ArchivePhoto[]> {
  const rows = await db
      .prepare(
        "SELECT id,data FROM photos ORDER BY rowid LIMIT ? OFFSET ?",
        "SELECT id,data FROM photos ORDER BY ordinal LIMIT ? OFFSET ?",
      )
      .all(limit, offset),
    photos = rows.map(
      (row) => ({ ...JSON.parse(String(row.data)), tags: [] }) as ArchivePhoto,
    );
  if (!photos.length) return photos;
  const photoMap = new Map(photos.map((photo) => [photo.id, photo])),
    placeholders = photos.map(() => "?").join(","),
    tags = await db
      .prepare(
        `SELECT photo_id,data FROM photo_tags WHERE photo_id IN (${placeholders}) ORDER BY rowid`,
        `SELECT photo_id,data FROM photo_tags WHERE photo_id IN (${placeholders}) ORDER BY ordinal`,
      )
      .all(...photos.map((photo) => photo.id));
  for (const row of tags)
    photoMap.get(String(row.photo_id))?.tags.push(JSON.parse(String(row.data)));
  return photos;
}

export async function readArchive(db: StoreDatabase) {
  const meta = (await db
    .prepare(
      "SELECT * FROM archive WHERE id=1",
      "SELECT * FROM archives WHERE id=current_setting('drevo.archive_id', true)",
    )
    .get())!;
  return hydrateArchive(
    meta,
    await db
      .prepare(
        "SELECT data FROM people ORDER BY rowid",
        "SELECT data FROM people ORDER BY ordinal",
      )
      .all(),
    await db
      .prepare(
        "SELECT * FROM relations ORDER BY rowid",
        "SELECT * FROM relations ORDER BY ordinal",
      )
      .all(),
    await db
      .prepare(
        "SELECT data FROM photos ORDER BY rowid",
        "SELECT data FROM photos ORDER BY ordinal",
      )
      .all(),
    await db
      .prepare(
        "SELECT photo_id,data FROM photo_tags ORDER BY rowid",
        "SELECT photo_id,data FROM photo_tags ORDER BY ordinal",
      )
      .all(),
  );
}
