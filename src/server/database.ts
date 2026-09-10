import { authorizeArchive } from "./permissions.ts";
import type { ArchiveUser } from "../domain/access.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { auditStore } from "./audit.ts";
import {
  validateFamily,
  type Family,
  type Person,
  type FamilyLink,
  type ArchivePhoto,
} from "../domain/index.ts";

export class ConflictError extends Error {}
export type ArchivePageCollection = "people" | "photos";

export function openArchive(path: string, seed: Family) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS archive (id INTEGER PRIMARY KEY CHECK(id=1), title TEXT NOT NULL, description TEXT NOT NULL, demo INTEGER NOT NULL, revision INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
    CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE, target TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE, type TEXT NOT NULL CHECK(type IN ('parent','spouse','adoptive_parent','godparent','nurse','sworn_sibling','guardian')), note TEXT NOT NULL DEFAULT '', CHECK(source<>target), UNIQUE(source,target,type)) STRICT;
    CREATE INDEX IF NOT EXISTS relations_target ON relations(target);
    CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
    CREATE TABLE IF NOT EXISTS photo_tags (id TEXT PRIMARY KEY, photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE, person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
    CREATE INDEX IF NOT EXISTS photo_tags_person ON photo_tags(person_id);
    CREATE TABLE IF NOT EXISTS history (revision INTEGER PRIMARY KEY, saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), data TEXT NOT NULL CHECK(json_valid(data))) STRICT;`);
  if (
    !db
      .prepare("PRAGMA table_info(relations)")
      .all()
      .some((row) => row.name === "created_by")
  )
    db.exec("ALTER TABLE relations ADD COLUMN created_by TEXT");
  const audit = auditStore(db);
  const read = () => readArchive(db),
    meta = () => readArchiveMeta(db),
    page = (collection: ArchivePageCollection, offset: number, limit: number) =>
      readArchivePage(db, collection, offset, limit);
  function write(
    value: unknown,
    expected: number,
    actor?: ArchiveUser,
    operation?: string,
  ) {
    const family = actor
      ? authorizeArchive(value, read().family, actor)
      : validateFamily(value);
    db.exec("BEGIN IMMEDIATE");
    try {
      const old = db.prepare("SELECT revision FROM archive WHERE id=1").get();
      if (old && Number(old.revision) !== expected)
        throw new ConflictError(
          "Архив изменён в другой вкладке. Обновите данные перед сохранением.",
        );
      if (old)
        db.prepare(
          "INSERT OR REPLACE INTO history(revision,data) VALUES(?,?)",
        ).run(Number(old.revision), JSON.stringify(read().family));
      if (old) audit.archive(read().family, family, actor, expected + 1);
      if (old && operation)
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
          expected + 1,
        );
      db.exec(
        "DELETE FROM photo_tags; DELETE FROM photos; DELETE FROM relations; DELETE FROM people;",
      );
      const personQuery = db.prepare("INSERT INTO people(id,data) VALUES(?,?)");
      for (const p of family.people)
        personQuery.run(
          p.id,
          JSON.stringify({ ...p, parents: undefined, spouses: undefined }),
        );
      const edgeQuery = db.prepare(
        "INSERT INTO relations(id,source,target,type,note) VALUES(?,?,?,?,?)",
      );
      const spouses = new Set<string>();
      for (const p of family.people) {
        for (const parent of p.parents)
          edgeQuery.run(`parent:${parent}:${p.id}`, parent, p.id, "parent", "");
        for (const spouse of p.spouses) {
          const pair = [p.id, spouse].sort(),
            key = JSON.stringify(pair);
          if (!spouses.has(key)) {
            edgeQuery.run(`spouse:${key}`, pair[0], pair[1], "spouse", "");
            spouses.add(key);
          }
        }
      }
      for (const l of family.links || []) {
        edgeQuery.run(l.id, l.from, l.to, l.type, l.note || "");
        if (l.createdBy)
          db.prepare("UPDATE relations SET created_by=? WHERE id=?").run(
            l.createdBy,
            l.id,
          );
      }
      const photoQuery = db.prepare("INSERT INTO photos(id,data) VALUES(?,?)"),
        tagQuery = db.prepare(
          "INSERT INTO photo_tags(id,photo_id,person_id,data) VALUES(?,?,?,?)",
        );
      for (const photo of family.photos || []) {
        photoQuery.run(photo.id, JSON.stringify({ ...photo, tags: undefined }));
        for (const tag of photo.tags)
          tagQuery.run(
            `${photo.id}:${tag.id}`,
            photo.id,
            tag.personId,
            JSON.stringify(tag),
          );
      }
      db.prepare(
        "INSERT INTO archive VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,demo=excluded.demo,revision=excluded.revision",
      ).run(
        family.title,
        family.description,
        Number(family.demo),
        expected + 1,
      );
      db.exec(
        "DELETE FROM history WHERE revision NOT IN (SELECT revision FROM history ORDER BY revision DESC LIMIT 50); COMMIT;",
      );
      return read();
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (!db.prepare("SELECT id FROM archive WHERE id=1").get()) write(seed, 0);
  return { read, meta, page, write, close: () => db.close(), db };
}

export function readArchiveMeta(db: DatabaseSync) {
  const meta = db.prepare("SELECT * FROM archive WHERE id=1").get()!;
  return {
    title: String(meta.title),
    description: String(meta.description),
    demo: !!meta.demo,
    revision: Number(meta.revision),
    people: Number(db.prepare("SELECT count(*) AS n FROM people").get()!.n),
    photos: Number(db.prepare("SELECT count(*) AS n FROM photos").get()!.n),
  };
}

export function readArchivePage(
  db: DatabaseSync,
  collection: ArchivePageCollection,
  offset: number,
  limit: number,
): Person[] | ArchivePhoto[] {
  if (collection === "people")
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
  const map = new Map(people.map((p) => [p.id, p]));
  const links: FamilyLink[] = [];
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
  const photos = db
    .prepare("SELECT data FROM photos ORDER BY rowid")
    .all()
    .map(
      (row) => ({ ...JSON.parse(String(row.data)), tags: [] }) as ArchivePhoto,
    );
  const photoMap = new Map(photos.map((p) => [p.id, p]));
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
