import { authorizeArchive } from "./permissions.ts";
import type { ArchiveUser } from "../domain/access.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { auditStore } from "./audit.ts";
import { initializeArchiveSchema } from "./schema.ts";
import {
  validateFamily,
  type Family,
  type Person,
  type FamilyLink,
  type ArchivePhoto,
} from "../domain/index.ts";

export class ConflictError extends Error {}

const mediaNamePattern = /^[a-zA-Z0-9-]+\.(jpg|png|webp|gif)$/;

function mediaReferences(family: Family) {
  const result = new Set<string>();
  for (const url of [
    ...family.people.map((person) => person.photo),
    ...(family.photos || []).map((photo) => photo.url),
  ]) {
    if (!url?.startsWith("/media/")) continue;
    const name = url.slice("/media/".length);
    if (mediaNamePattern.test(name)) result.add(name);
  }
  return result;
}

function removeMediaFiles(path: string, names: Iterable<string>) {
  if (path === ":memory:") return;
  const uploads = resolve(dirname(path), "uploads");
  for (const name of names) {
    if (!mediaNamePattern.test(name)) continue;
    try {
      rmSync(resolve(uploads, name), { force: true });
    } catch (error) {
      console.error(`Не удалось удалить бесхозное медиа ${name}`, error);
    }
  }
}

function removeDroppedMedia(path: string, before: Family, after: Family) {
  const current = mediaReferences(after);
  removeMediaFiles(
    path,
    [...mediaReferences(before)].filter((name) => !current.has(name)),
  );
}

type JsonRow = { id: string; data: string };
type RelationRow = {
  id: string;
  source: string;
  target: string;
  type: string;
  note: string;
  createdBy: string | null;
};
type TagRow = {
  id: string;
  photoId: string;
  personId: string;
  data: string;
};

type ArchiveRows = {
  people: JsonRow[];
  relations: RelationRow[];
  photos: JsonRow[];
  tags: TagRow[];
};

function archiveRows(family: Family): ArchiveRows {
  const people = family.people.map((person) => ({
    id: person.id,
    data: JSON.stringify({
      ...person,
      parents: undefined,
      spouses: undefined,
    }),
  }));
  const relations: RelationRow[] = [];
  const spouses = new Set<string>();
  for (const person of family.people) {
    for (const parent of person.parents)
      relations.push({
        id: `parent:${parent}:${person.id}`,
        source: parent,
        target: person.id,
        type: "parent",
        note: "",
        createdBy: null,
      });
    for (const spouse of person.spouses) {
      const pair = [person.id, spouse].sort(),
        key = JSON.stringify(pair);
      if (spouses.has(key)) continue;
      spouses.add(key);
      relations.push({
        id: `spouse:${key}`,
        source: pair[0],
        target: pair[1],
        type: "spouse",
        note: "",
        createdBy: null,
      });
    }
  }
  for (const link of family.links || [])
    relations.push({
      id: link.id,
      source: link.from,
      target: link.to,
      type: link.type,
      note: link.note || "",
      createdBy: link.createdBy || null,
    });

  const photos: JsonRow[] = [],
    tags: TagRow[] = [];
  for (const photo of family.photos || []) {
    photos.push({
      id: photo.id,
      data: JSON.stringify({ ...photo, tags: undefined }),
    });
    for (const tag of photo.tags)
      tags.push({
        id: `${photo.id}:${tag.id}`,
        photoId: photo.id,
        personId: tag.personId,
        data: JSON.stringify(tag),
      });
  }
  return { people, relations, photos, tags };
}

function preservesRowOrder(before: string[], after: string[]) {
  const beforeSet = new Set(before),
    afterSet = new Set(after),
    survivingBefore = before.filter((id) => afterSet.has(id)),
    survivingAfter = after.filter((id) => beforeSet.has(id));
  if (
    survivingBefore.length !== survivingAfter.length ||
    survivingBefore.some((id, index) => id !== survivingAfter[index])
  )
    return false;
  let sawNew = false;
  for (const id of after) {
    if (!beforeSet.has(id)) sawNew = true;
    else if (sawNew) return false;
  }
  return true;
}

function canPersistIncrementally(before: ArchiveRows, after: ArchiveRows) {
  const ordered = (
    previous: { id: string }[],
    next: { id: string }[],
  ) => preservesRowOrder(
    previous.map((row) => row.id),
    next.map((row) => row.id),
  );
  if (
    !ordered(before.people, after.people) ||
    !ordered(before.relations, after.relations) ||
    !ordered(before.photos, after.photos) ||
    !ordered(before.tags, after.tags)
  )
    return false;

  // source/target/type участвуют в UNIQUE. При их замене два живых ряда могут
  // временно конфликтовать друг с другом, поэтому такой редкий случай безопаснее
  // отдать полному rewrite. note/created_by обновляются на месте.
  const oldRelations = new Map(before.relations.map((row) => [row.id, row]));
  return after.relations.every((row) => {
    const old = oldRelations.get(row.id);
    return (
      !old ||
      (old.source === row.source &&
        old.target === row.target &&
        old.type === row.type)
    );
  });
}

function replaceArchiveRows(db: DatabaseSync, rows: ArchiveRows) {
  db.exec(
    "DELETE FROM photo_tags; DELETE FROM photos; DELETE FROM relations; DELETE FROM people;",
  );
  const personQuery = db.prepare("INSERT INTO people(id,data) VALUES(?,?)");
  for (const row of rows.people) personQuery.run(row.id, row.data);

  const relationQuery = db.prepare(
    "INSERT INTO relations(id,source,target,type,note,created_by) VALUES(?,?,?,?,?,?)",
  );
  for (const row of rows.relations)
    relationQuery.run(
      row.id,
      row.source,
      row.target,
      row.type,
      row.note,
      row.createdBy,
    );

  const photoQuery = db.prepare("INSERT INTO photos(id,data) VALUES(?,?)"),
    tagQuery = db.prepare(
      "INSERT INTO photo_tags(id,photo_id,person_id,data) VALUES(?,?,?,?)",
    );
  for (const row of rows.photos) photoQuery.run(row.id, row.data);
  for (const row of rows.tags)
    tagQuery.run(row.id, row.photoId, row.personId, row.data);
}

function syncJsonRows(
  db: DatabaseSync,
  table: "people" | "photos",
  before: JsonRow[],
  after: JsonRow[],
  deleteRemoved = true,
) {
  const previous = new Map(before.map((row) => [row.id, row.data]));
  const nextIds = new Set(after.map((row) => row.id));
  const insert = db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)`),
    update = db.prepare(`UPDATE ${table} SET data=? WHERE id=?`),
    remove = db.prepare(`DELETE FROM ${table} WHERE id=?`);
  for (const row of after) {
    if (!previous.has(row.id)) insert.run(row.id, row.data);
    else if (previous.get(row.id) !== row.data) update.run(row.data, row.id);
  }
  if (deleteRemoved)
    for (const row of before) if (!nextIds.has(row.id)) remove.run(row.id);
}

function syncRelations(
  db: DatabaseSync,
  before: RelationRow[],
  after: RelationRow[],
) {
  const previous = new Map(before.map((row) => [row.id, row])),
    nextIds = new Set(after.map((row) => row.id)),
    remove = db.prepare("DELETE FROM relations WHERE id=?"),
    insert = db.prepare(
      "INSERT INTO relations(id,source,target,type,note,created_by) VALUES(?,?,?,?,?,?)",
    ),
    update = db.prepare(
      "UPDATE relations SET note=?,created_by=? WHERE id=?",
    );
  for (const row of before) if (!nextIds.has(row.id)) remove.run(row.id);
  for (const row of after) {
    const old = previous.get(row.id);
    if (!old)
      insert.run(
        row.id,
        row.source,
        row.target,
        row.type,
        row.note,
        row.createdBy,
      );
    else if (old.note !== row.note || old.createdBy !== row.createdBy)
      update.run(row.note, row.createdBy, row.id);
  }
}

function syncTags(db: DatabaseSync, before: TagRow[], after: TagRow[]) {
  const previous = new Map(before.map((row) => [row.id, row])),
    nextIds = new Set(after.map((row) => row.id)),
    remove = db.prepare("DELETE FROM photo_tags WHERE id=?"),
    insert = db.prepare(
      "INSERT INTO photo_tags(id,photo_id,person_id,data) VALUES(?,?,?,?)",
    ),
    update = db.prepare(
      "UPDATE photo_tags SET photo_id=?,person_id=?,data=? WHERE id=?",
    );
  for (const row of before) if (!nextIds.has(row.id)) remove.run(row.id);
  for (const row of after) {
    const old = previous.get(row.id);
    if (!old) insert.run(row.id, row.photoId, row.personId, row.data);
    else if (
      old.photoId !== row.photoId ||
      old.personId !== row.personId ||
      old.data !== row.data
    )
      update.run(row.photoId, row.personId, row.data, row.id);
  }
}

function syncArchiveRows(
  db: DatabaseSync,
  before: ArchiveRows,
  after: ArchiveRows,
) {
  // Сначала создаём новые основные сущности, чтобы связи могли ссылаться на них.
  // Удаление старых people/photos откладываем до обновления зависимых строк.
  syncJsonRows(db, "people", before.people, after.people, false);
  syncJsonRows(db, "photos", before.photos, after.photos, false);
  syncRelations(db, before.relations, after.relations);
  syncTags(db, before.tags, after.tags);

  const nextPhotoIds = new Set(after.photos.map((row) => row.id)),
    nextPeopleIds = new Set(after.people.map((row) => row.id)),
    removePhoto = db.prepare("DELETE FROM photos WHERE id=?"),
    removePerson = db.prepare("DELETE FROM people WHERE id=?");
  for (const row of before.photos)
    if (!nextPhotoIds.has(row.id)) removePhoto.run(row.id);
  for (const row of before.people)
    if (!nextPeopleIds.has(row.id)) removePerson.run(row.id);
}

export function openArchive(path: string, seed: Family) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    initializeArchiveSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const audit = auditStore(db);
  const read = () => readArchive(db),
    meta = () => readArchiveMeta(db),
    overview = (includePortraits = true) =>
      readArchiveOverview(db, includePortraits),
    peoplePage = (offset: number, limit: number) =>
      readPeoplePage(db, offset, limit),
    photoPage = (offset: number, limit: number) =>
      readPhotoPage(db, offset, limit);

  const checkRevision = (expected: number) => {
    const old = db.prepare("SELECT revision FROM archive WHERE id=1").get();
    if (old && Number(old.revision) !== expected)
      throw new ConflictError(
        "Архив изменён в другой вкладке. Обновите данные перед сохранением.",
      );
    return old ? Number(old.revision) : null;
  };
  const remember = (
    previous: Family,
    family: Family,
    revision: number,
    actor?: ArchiveUser,
    operation?: string,
  ) => {
    db.prepare(
      "INSERT OR REPLACE INTO history(revision,data) VALUES(?,?)",
    ).run(revision, JSON.stringify(previous));
    audit.archive(previous, family, actor, revision + 1);
    if (operation)
      audit.record(
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
  const finishWrite = () =>
    db.exec(
      "DELETE FROM history WHERE revision NOT IN (SELECT revision FROM history ORDER BY revision DESC LIMIT 50); COMMIT;",
    );

  function write(
    value: unknown,
    expected: number,
    actor?: ArchiveUser,
    operation?: string,
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const oldRevision = checkRevision(expected);
      const previous = oldRevision === null ? null : read().family;
      const family =
        actor && previous
          ? authorizeArchive(value, previous, actor)
          : validateFamily(value);
      if (previous && oldRevision !== null)
        remember(previous, family, oldRevision, actor, operation);

      const nextRows = archiveRows(family);
      if (!previous || operation) replaceArchiveRows(db, nextRows);
      else {
        const previousRows = archiveRows(previous);
        if (canPersistIncrementally(previousRows, nextRows))
          syncArchiveRows(db, previousRows, nextRows);
        else replaceArchiveRows(db, nextRows);
      }

      db.prepare(
        "INSERT INTO archive VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,demo=excluded.demo,revision=excluded.revision",
      ).run(
        family.title,
        family.description,
        Number(family.demo),
        expected + 1,
      );
      finishWrite();
      if (previous && actor && !operation)
        removeDroppedMedia(path, previous, family);
      return { family, revision: expected + 1 };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function appendPhoto(value: ArchivePhoto, expected: number, actor: ArchiveUser) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const oldRevision = checkRevision(expected);
      if (oldRevision === null)
        throw new ConflictError("Архив ещё не создан");
      const previous = read().family;
      const family = authorizeArchive(
        {
          ...previous,
          photos: [...(previous.photos || []), value],
        },
        previous,
        actor,
      );
      const photo = family.photos!.find((item) => item.id === value.id)!;
      remember(previous, family, oldRevision, actor);
      db.prepare("INSERT INTO photos(id,data) VALUES(?,?)").run(
        photo.id,
        JSON.stringify({ ...photo, tags: undefined }),
      );
      const tagQuery = db.prepare(
        "INSERT INTO photo_tags(id,photo_id,person_id,data) VALUES(?,?,?,?)",
      );
      for (const tag of photo.tags)
        tagQuery.run(
          `${photo.id}:${tag.id}`,
          photo.id,
          tag.personId,
          JSON.stringify(tag),
        );
      db.prepare("UPDATE archive SET revision=? WHERE id=1").run(expected + 1);
      finishWrite();
      return { family, revision: expected + 1 };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  if (!db.prepare("SELECT id FROM archive WHERE id=1").get()) write(seed, 0);
  return {
    read,
    meta,
    overview,
    peoplePage,
    photoPage,
    write,
    appendPhoto,
    close: () => db.close(),
    db,
  };
}

export function readArchiveMeta(db: DatabaseSync) {
  const meta = db
    .prepare(
      `SELECT archive.*,
        (SELECT count(*) FROM people) AS people_count,
        (SELECT count(*) FROM photos) AS photos_count
       FROM archive WHERE id=1`,
    )
    .get()!;
  return {
    title: String(meta.title),
    description: String(meta.description),
    demo: !!meta.demo,
    revision: Number(meta.revision),
    people: Number(meta.people_count),
    photos: Number(meta.photos_count),
  };
}

function hydrateRelations(db: DatabaseSync, people: Person[]) {
  const map = new Map(people.map((person) => [person.id, person])),
    links: FamilyLink[] = [];
  for (const row of db
    .prepare("SELECT * FROM relations ORDER BY rowid")
    .all()) {
    const from = String(row.source),
      to = String(row.target),
      type = String(row.type);
    if (type === "parent") map.get(to)!.parents.push(from);
    else if (type === "spouse") {
      map.get(from)!.spouses.push(to);
      map.get(to)!.spouses.push(from);
    } else
      links.push({
        id: String(row.id),
        ...(row.created_by ? { createdBy: String(row.created_by) } : {}),
        from,
        to,
        type: type as FamilyLink["type"],
        ...(row.note ? { note: String(row.note) } : {}),
      });
  }
  return links;
}

/**
 * Начальная проекция для ReactFlow: весь родственный граф, но без фотографий,
 * источников, биографий, наград и событий. Тяжёлые JSON-поля отбрасывает сам
 * SQLite до передачи строки в Node.
 */
export function readArchiveOverview(
  db: DatabaseSync,
  includePortraits = true,
) {
  const meta = readArchiveMeta(db);
  const remove = [
    "$.sources",
    "$.biography",
    "$.occupation",
    "$.awards",
    "$.events",
    ...(includePortraits ? [] : ["$.photo"]),
  ];
  const placeholders = remove.map(() => "?").join(", ");
  const people = db
    .prepare(
      `SELECT json_set(json_remove(data, ${placeholders}), '$.sources', json('[]')) AS data
       FROM people ORDER BY rowid`,
    )
    .all(...remove)
    .map(
      (row) =>
        ({
          ...JSON.parse(String(row.data)),
          parents: [],
          spouses: [],
        }) as Person,
    );
  const links = hydrateRelations(db, people);
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

export function readPeoplePage(
  db: DatabaseSync,
  offset: number,
  limit: number,
): Person[] {
  return db
    .prepare("SELECT data FROM people ORDER BY rowid LIMIT ? OFFSET ?")
    .all(limit, offset)
    .map(
      (row) =>
        ({
          ...JSON.parse(String(row.data)),
          parents: [],
          spouses: [],
        }) as Person,
    );
}

export function readPhotoPage(
  db: DatabaseSync,
  offset: number,
  limit: number,
): ArchivePhoto[] {
  const rows = db
      .prepare("SELECT id,data FROM photos ORDER BY rowid LIMIT ? OFFSET ?")
      .all(limit, offset),
    photos = rows.map(
      (row) => ({ ...JSON.parse(String(row.data)), tags: [] }) as ArchivePhoto,
    );
  if (!photos.length) return photos;
  const photoMap = new Map(photos.map((photo) => [photo.id, photo])),
    placeholders = photos.map(() => "?").join(","),
    tags = db
      .prepare(
        `SELECT photo_id,data FROM photo_tags WHERE photo_id IN (${placeholders}) ORDER BY rowid`,
      )
      .all(...photos.map((photo) => photo.id));
  for (const row of tags)
    photoMap.get(String(row.photo_id))?.tags.push(JSON.parse(String(row.data)));
  return photos;
}

export function readArchive(db: DatabaseSync) {
  const meta = db.prepare("SELECT * FROM archive WHERE id=1").get()!;
  const people = db
    .prepare("SELECT data FROM people ORDER BY rowid")
    .all()
    .map(
      (row) =>
        ({
          ...JSON.parse(String(row.data)),
          parents: [],
          spouses: [],
        }) as Person,
    );
  const links = hydrateRelations(db, people);
  const photos = db
    .prepare("SELECT data FROM photos ORDER BY rowid")
    .all()
    .map(
      (row) => ({ ...JSON.parse(String(row.data)), tags: [] }) as ArchivePhoto,
    );
  const photoMap = new Map(photos.map((photo) => [photo.id, photo]));
  for (const row of db
    .prepare("SELECT photo_id,data FROM photo_tags ORDER BY rowid")
    .all())
    photoMap.get(String(row.photo_id))!.tags.push(JSON.parse(String(row.data)));
  return {
    family: {
      title: String(meta.title),
      description: String(meta.description),
      demo: !!meta.demo,
      people,
      links,
      photos,
    } as Family,
    revision: Number(meta.revision),
  };
}
