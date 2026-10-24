import { enforceUserStorageLimit, userStorageBytes } from "./storage-limits.ts";
import { authorizeArchive } from "./permissions.ts";
import { assertCurrentArchiveActor } from "./users.ts";
import { checkStorePostgresPeopleGrowth } from "./postgres-people-quota.ts";
import { authorizeMediaReferences } from "./media-access.ts";
import {
  enforcePostgresMediaQuota,
  postgresMediaBytes,
  releaseAttachedMediaGrants,
} from "./postgres-media-quota.ts";
import type { ArchiveUser } from "../domain/access.ts";
import { archiveOverview } from "../domain/archive-projection.ts";
import { projectFamilyToVisibleIds } from "../domain/tree-access.ts";
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
  galleryProjection,
  galleryProjectionIndex,
  galleryIndexPage,
  type GalleryProjectionIndex,
  type GalleryQuery,
} from "../domain/archive-view-projection.ts";
import type { PostgresConnections } from "./postgres-connections.ts";
import {
  archiveRows,
  type ArchiveRows,
  type JsonRow,
  type RelationRow,
  type TagRow,
  type UnionRow,
} from "./archive-rows.ts";
import { initializeArchiveSchema } from "./schema.ts";
import { ConflictError } from "./archive-errors.ts";
import { prepareAwardCitationWrite } from "./award-citation-write.ts";
import { patchPeople } from "./person-patches.ts";
import { archiveSnapshotReader, archiveSnapshotBudget, archiveCacheView } from "./archive-read-cache.ts";
import { archiveVisibilityReader } from "./archive-visibility-cache.ts";
import { createHash } from "node:crypto";
import { hydrateArchive, hydrateRelations } from "./archive-hydration.ts";
import {
  allCitations,
  assertCatalogLinks,
  hydrateCatalogCitations,
} from "./source-catalog-store.ts";
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
  const citationUrls = (family: Family) =>
    allCitations(family)
      .map((citation) => citation.url?.split(/[?#]/, 1)[0])
      .filter((url): url is string => !!url?.startsWith("/media/"));
  const existing = new Set([
    ...before.people.map((person) => person.photo),
    ...(before.photos || []).map((photo) => photo.url),
    ...citationUrls(before),
  ]);
  return (
    after.people.some(
      (person) => person.photo && !existing.has(person.photo),
    ) ||
    (after.photos || []).some((photo) => !existing.has(photo.url)) ||
    citationUrls(after).some((url) => !existing.has(url))
  );
}

async function replaceArchiveRows(db: StoreDatabase, rows: ArchiveRows) {
  await db.exec(
    "DELETE FROM photo_tags; DELETE FROM photos; DELETE FROM family_unions; DELETE FROM relations; DELETE FROM people;",
    "DELETE FROM photo_tags; DELETE FROM photos; DELETE FROM family_unions; DELETE FROM relations; DELETE FROM people;",
  );
  const personQuery = db.prepare(
    "INSERT INTO people(id,data) VALUES(?,?)",
    "INSERT INTO people(id,data) VALUES(?,?)",
  );
  for (const row of rows.people) await personQuery.run(row.id, row.data);
  const unionQuery = db.prepare(
    "INSERT INTO family_unions(id,participant_a,participant_b,data) VALUES(?,?,?,?)",
    "INSERT INTO family_unions(id,participant_a,participant_b,data) VALUES(?,?,?,?)",
  );
  for (const row of rows.unions)
    await unionQuery.run(row.id, row.participantA, row.participantB, row.data);

  const relationQuery = db.prepare(
    "INSERT INTO relations(id,source,target,type,note,twin_kind,created_by,sources,confidence) VALUES(?,?,?,?,?,?,?,?,?)",
    "INSERT INTO relations(id,source,target,type,note,twin_kind,created_by,sources,confidence) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (const row of rows.relations)
    await relationQuery.run(
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
  await restoreOrder("family_unions", before.unions, after.unions);
  await restoreOrder("photos", before.photos, after.photos);
  await restoreOrder("photo_tags", before.tags, after.tags);
}

export async function openArchive(
  path: string,
  seed: Family,
  archiveId?: string,
  connections?: PostgresConnections,
  snapshotBudget?: ReturnType<typeof archiveSnapshotBudget>,
) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  let db: StoreDatabase;
  if (configuredDatabaseBackend(path) === "postgres" && path !== ":memory:") {
    db = await openPostgresDatabase(
      archiveId ?? process.env.ARCHIVE_ID ?? "",
      path,
      connections,
    );
  } else {
    if (archiveId)
      throw new Error("Явный archive_id поддерживается только PostgreSQL");
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
  const derivedBudget = archiveCacheView(snapshotBudget ?? archiveSnapshotBudget());
  const visibilityIds = archiveVisibilityReader(db, () => db.transaction(() => readArchiveVisibilityGraph(db), true), derivedBudget);
  const cacheBytes = 16 * 1024 ** 2;
  const read = archiveSnapshotReader(
      db,
      () => db.transaction(() => readArchive(db), true),
      cacheBytes,
      derivedBudget,
    ),
    meta = async () => await readArchiveMeta(db),
    portraitOverview = archiveSnapshotReader(
      db,
      () => db.transaction(() => readArchiveOverview(db, true), true),
      cacheBytes,
      derivedBudget,
    ),
    anonymousOverview = archiveSnapshotReader(
      db,
      () => db.transaction(() => readArchiveOverview(db, false), true),
      cacheBytes,
      derivedBudget,
    ),
    overview = (includePortraits = true) =>
      includePortraits ? portraitOverview() : anonymousOverview(),
    peoplePage = async (
      offset: number,
      limit: number,
      visible?: ReadonlySet<string>,
    ) => await readPeoplePage(db, offset, limit, visible),
    photoPage = async (
      offset: number,
      limit: number,
      scope?: PhotoReadScope,
      tagged?: ReadonlySet<string>,
      ids?: ReadonlySet<string>,
    ) =>
      await db.transaction(
        () => readPhotoPage(db, offset, limit, scope, tagged, ids),
        true,
      ),
    photoCount = async (
      scope?: PhotoReadScope,
      tagged?: ReadonlySet<string>,
    ) => {
      const where = photoReadWhere(scope, tagged);
      return Number(
        (
          await db
            .prepare(
              `SELECT count(*) AS count FROM photos${where.sqlite}`,
              `SELECT count(*) AS count FROM photos${where.postgres}`,
            )
            .get(...where.args)
        )?.count || 0,
      );
    };
  // Reuse the existing process-wide byte budget, never cache authentication or
  // HTTP responses. Reader keys include every input used by visiblePersonIds.
  const scopedOverviews = new Map<string, ReturnType<typeof archiveSnapshotReader<Awaited<ReturnType<typeof readArchiveOverview>>>>>();
  const loadScopedOverview = async (actor: ArchiveUser) => {
    const filtered = async (visible: ReadonlySet<string>) => {
      const data = await readArchiveOverview(db, true, visible);
      return { ...data, family: archiveOverview(data.family), totals: {
        people: data.family.people.length, photos: await photoCount({ visible, userId: actor.id }),
      } };
    };
    const prepared = await db.transaction(async () => {
      const visible = await visibilityIds(actor), meta = await readArchiveMeta(db);
      // A wide cache miss should share the existing base overview rather than
      // reread nearly every JSON row separately for each newly arriving member.
      if (visible.size * 2 > meta.people) return { visible, revision: meta.revision };
      return { data: await filtered(visible) };
    }, true);
    if (prepared.data) return prepared.data;
    const base = await overview();
    return db.transaction(async () => {
      const meta = await readArchiveMeta(db);
      if (meta.revision !== prepared.revision || meta.revision !== base.revision)
        return filtered(await visibilityIds(actor));
      const family = archiveOverview(projectFamilyToVisibleIds(base.family, prepared.visible!, actor.id));
      return { ...base, family, totals: { people: family.people.length,
        photos: await photoCount({ visible: prepared.visible!, userId: actor.id }) } };
    }, true);
  };
  const scopedOverview = (user: ArchiveUser) => {
    const scope = JSON.stringify([user.id, user.personId, user.treeAccess, user.role,
      user.approved, user.archiveOwner, user.globalRole]);
    let reader = scopedOverviews.get(scope);
    if (reader) scopedOverviews.delete(scope);
    else {
      const actor = { ...user };
      reader = archiveSnapshotReader(db, () => loadScopedOverview(actor), cacheBytes, derivedBudget);
      if (scopedOverviews.size >= 16) {
        const oldest = scopedOverviews.keys().next().value!;
        scopedOverviews.get(oldest)!.close();
        scopedOverviews.delete(oldest);
      }
    }
    scopedOverviews.set(scope, reader);
    return reader();
  };
  const personPhotoCounts = async (ids: ReadonlySet<string>, scope?: PhotoReadScope) => {
    const where = photoReadWhere(scope);
    const rows = await db.prepare(
      `SELECT person_id,count(DISTINCT photo_id) AS total FROM photo_tags WHERE photo_id IN (SELECT id FROM photos${where.sqlite}) AND person_id IN (SELECT value FROM json_each(?)) GROUP BY person_id`,
      `SELECT person_id,count(DISTINCT photo_id) AS total FROM photo_tags WHERE photo_id IN (SELECT id FROM photos${where.postgres}) AND person_id IN (SELECT jsonb_array_elements_text(?::jsonb)) GROUP BY person_id`,
    ).all(...where.args, JSON.stringify([...ids]));
    return Object.fromEntries([...ids].map(id => [id, Number(rows.find(row => row.person_id === id)?.total || 0)]));
  };
  const viewPeople = async (
    view: "places" | "gallery" | "timeline",
    visible?: ReadonlySet<string>,
  ) => {
    const fields =
      view === "places"
        ? ["id", "events"]
        : view === "timeline" ? ["id", "events", "awards"] : ["id", "surname", "name", "patronymic"];
    const people = (
      await db
        .prepare(
          `SELECT json_object(${fields.map((field) => `'${field}',json_extract(data,'$.${field}')`).join(",")}) AS data FROM people${visible ? " WHERE id IN (SELECT value FROM json_each(?))" : ""} ORDER BY rowid`,
          `SELECT jsonb_build_object(${fields.map((field) => `'${field}',data->'${field}'`).join(",")}) AS data FROM people${visible ? " WHERE id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))" : ""} ORDER BY ordinal`,
        )
        .all(...(visible ? [JSON.stringify([...visible])] : []))
    ).map(
      (row) =>
        ({
          ...JSON.parse(String(row.data)),
          sources: [],
          parents: [],
          spouses: [],
        }) as Person,
    );
    if (view === "places" || view === "timeline")
      await hydrateCatalogCitations(db, {
        title: "",
        description: "",
        demo: false,
        people,
      });
    return people;
  };
  const galleryKeys = new Map<string, symbol>();
  const galleryPending = new Map<string, Promise<Family>>();
  const gallery = async (
    query: GalleryQuery,
    scope?: PhotoReadScope,
    readTree = true,
    readPhotos = true,
  ) => {
    const revision = Number((await db.prepare("SELECT revision FROM archive WHERE id=1", "SELECT revision FROM archives WHERE id=current_setting('drevo.archive_id',true)").get())?.revision);
    const reusable = db.canReuseGraphCache();
    const scopeKey = createHash("sha256").update(JSON.stringify([revision, readTree, readPhotos, scope?.userId || "", scope ? [...scope.visible].sort() : null])).digest("hex");
    const cacheKey = galleryKeys.get(scopeKey);
    let index = reusable && cacheKey ? derivedBudget.getDerived<Family>(cacheKey) : undefined;
    if (!readPhotos) return galleryProjection({ title: "", description: "", demo: false, people: readTree ? await viewPeople("gallery", scope?.visible) : [], photos: [] }, query);
    if (!index) {
      const loadIndex = async (): Promise<Family> => {
        const people = readTree ? await viewPeople("gallery", scope?.visible) : [];
        const where = photoReadWhere(scope);
        const fields = ["id", "url", "title", "year", "takenAt", "createdAt"];
        // Materialize compact album/order fields; full annotations/descriptions
        // are fetched only for the 30 photographs in the current page below.
        const photos = (await db.prepare(
          `SELECT json_object(${fields.map((field) => `'${field}',json_extract(data,'$.${field}')`).join(",")}) AS data FROM photos${where.sqlite} ORDER BY rowid`,
          `SELECT jsonb_build_object(${fields.map((field) => `'${field}',data->'${field}'`).join(",")}) AS data FROM photos${where.postgres} ORDER BY ordinal`,
        ).all(...where.args)).map(row => ({ ...JSON.parse(String(row.data)), tags: [] }) as ArchivePhoto);
        const byId = new Map(photos.map(photo => [photo.id, photo]));
        if (readTree) for (const tag of await db.prepare(
          `SELECT photo_id,person_id FROM photo_tags WHERE photo_id IN (SELECT id FROM photos${where.sqlite}) ORDER BY rowid`,
          `SELECT photo_id,person_id FROM photo_tags WHERE photo_id IN (SELECT id FROM photos${where.postgres}) ORDER BY ordinal`,
        ).all(...where.args)) {
          if (!scope || scope.visible.has(String(tag.person_id)))
            byId.get(String(tag.photo_id))?.tags.push({ personId: String(tag.person_id) } as ArchivePhoto["tags"][number]);
        }
        return { title: "", description: "", demo: false, people, photos };
      };
      let loading = reusable ? galleryPending.get(scopeKey) : undefined;
      if (!loading) {
        loading = loadIndex();
        if (reusable && galleryPending.size < 16) {
          galleryPending.set(scopeKey, loading);
          const owned = loading;
          void loading.finally(() => { if (galleryPending.get(scopeKey) === owned) galleryPending.delete(scopeKey); }).catch(() => {});
        }
      }
      index = await loading;
      if (reusable) {
        const bytes = JSON.stringify(index).length * 4;
        if (bytes <= 16 * 1024 ** 2) {
          const key = galleryKeys.get(scopeKey) ?? Symbol("gallery index");
          if (galleryKeys.size >= 16 && !galleryKeys.has(scopeKey)) derivedBudget.remove(galleryKeys.values().next().value!);
          derivedBudget.setDerived(key, index, bytes, () => { if (galleryKeys.get(scopeKey) === key) galleryKeys.delete(scopeKey); });
          galleryKeys.set(scopeKey, key);
        }
      }
    }
    const queryKey = `query:${scopeKey}:${JSON.stringify([query.mode, query.personId || null, query.year || null, query.personIds ? [...query.personIds].sort() : null])}`;
    const derivedKey = galleryKeys.get(queryKey);
    let prepared = reusable && derivedKey ? derivedBudget.getDerived<GalleryProjectionIndex>(derivedKey) : undefined;
    if (!prepared) {
      prepared = galleryProjectionIndex(index, query);
      const bytes = JSON.stringify(prepared).length * 4;
      if (reusable && bytes <= 16 * 1024 ** 2) {
        const key = derivedKey ?? Symbol("gallery query index");
        if (galleryKeys.size >= 16 && !galleryKeys.has(queryKey)) derivedBudget.remove(galleryKeys.values().next().value!);
        derivedBudget.setDerived(key, prepared, bytes, () => { if (galleryKeys.get(queryKey) === key) galleryKeys.delete(queryKey); });
        galleryKeys.set(queryKey, key);
      }
    }
    const result = galleryIndexPage(prepared, query);
    if (result.photos.length) {
      const rows = await photoPage(
        0,
        result.photos.length,
        scope,
        undefined,
        new Set(result.photos.map((photo) => photo.id)),
      );
      const selected = new Map(rows.map((photo) => [photo.id, photo]));
      result.photos = result.photos.map((photo) => {
        const full = selected.get(photo.id)!;
        return readTree ? full : { ...full, tags: [] };
      });
    }
    return result;
  };

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
    beforeWrite?: (db: StoreDatabase) => void | Promise<void>,
    options: { withinTransaction?: boolean } = {},
  ) {
    const apply = async () => {
      const oldRevision = await checkRevision(expected);
      if (actor) await assertCurrentArchiveActor(db, actor);
      const previous =
        oldRevision === null ? null : knownPrevious || (await read()).family;
      const family =
        actor && previous
          ? authorizeArchive(value, previous, actor)
          : prepareAwardCitationWrite(
              structuredClone(validateFamily(value)),
              previous,
            );
      await checkStorePostgresPeopleGrowth(
        db,
        family.people.length - (previous?.people.length || 0),
      );
      if (actor && previous)
        await authorizeMediaReferences(db, previous, family, actor);
      await beforeWrite?.(db);
      const mediaActorId =
        actor && previous && addsMediaReference(previous, family)
          ? actor.id
          : null;
      const measuredAt = Date.now();
      const archiveBytesBefore = mediaActorId
        ? await postgresMediaBytes(db, measuredAt)
        : 0;
      const userBytesBefore = mediaActorId
        ? await userStorageBytes(db, mediaActorId, measuredAt)
        : 0;
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
      await assertCatalogLinks(db, family);
      if (mediaActorId) {
        await releaseAttachedMediaGrants(db);
        await enforcePostgresMediaQuota(db, archiveBytesBefore, measuredAt);
        await enforceUserStorageLimit(
          db,
          mediaActorId,
          0,
          false,
          measuredAt,
          userBytesBefore,
        );
      }
      await finishWrite();
      return { family, revision: expected + 1 };
    };
    if (options.withinTransaction) {
      if (!db.inTransaction()) throw new Error("Ожидается транзакция архива");
      return await apply();
    }
    return await db.transaction(apply);
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
      const measuredAt = Date.now();
      const archiveBytesBefore = await postgresMediaBytes(db, measuredAt);
      const userBytesBefore = await userStorageBytes(db, actor.id, measuredAt);
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
      await enforcePostgresMediaQuota(db, archiveBytesBefore, measuredAt);
      await enforceUserStorageLimit(
        db,
        actor.id,
        0,
        false,
        measuredAt,
        userBytesBefore,
      );
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
    read: () => read(),
    meta,
    overview,
    scopedOverview,
    peoplePage,
    photoPage,
    photoCount,
    write,
    patchPeople: async (
      changes: Parameters<typeof patchPeople>[1],
      expected: number,
      actor: ArchiveUser,
      options: Parameters<typeof patchPeople>[4] = {},
    ) => await patchPeople(db, changes, expected, actor, options),
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
          ["drevo-person-patches-v1", "drevo-archive-changes-v1"].includes(saved.format)
            ? applyArchiveChanges(family, saved.changes, "local").family
            : saved;
        nextRevision--;
      }
      if (nextRevision !== revision)
        throw new Error("Версия больше не хранится в истории");
      return validateFamily(family);
    },
    appendPhoto,
    viewPeople,
    gallery,
    personPhotoCounts,
    exportWarnings: (ids: ReadonlySet<string>) => readExportWarnings(db, ids),
    visibleIds: visibilityIds,
    cacheBudget: derivedBudget,
    close: async () => { read.close(); portraitOverview.close(); anonymousOverview.close(); visibilityIds.close(); for (const reader of scopedOverviews.values()) reader.close(); scopedOverviews.clear(); galleryKeys.clear(); galleryPending.clear(); derivedBudget.close(); await db.close(); },
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
export async function readArchiveVisibilityGraph(db: StoreDatabase) {
  const revision = Number((await db.prepare("SELECT revision FROM archive WHERE id=1", "SELECT revision FROM archives WHERE id=current_setting('drevo.archive_id',true)").get())?.revision);
  const people = (await db.prepare(
    "SELECT id,json_extract(data,'$.createdBy') AS created_by FROM people ORDER BY rowid",
    "SELECT id,data->>'createdBy' AS created_by FROM people ORDER BY ordinal",
  ).all()).map(row => ({ id: String(row.id), ...(row.created_by ? { createdBy: String(row.created_by) } : {}), name: "", surname: "", patronymic: "", sex: "u", birth: "", birthPlace: "", generation: 1, column: 0, parents: [], spouses: [], sources: [] }) as Person);
  const links = hydrateRelations(await db.prepare("SELECT id,source,target,type FROM relations ORDER BY rowid", "SELECT id,source,target,type FROM relations ORDER BY ordinal").all(), people);
  const unions = (await db.prepare("SELECT id,participant_a,participant_b FROM family_unions ORDER BY rowid", "SELECT id,participant_a,participant_b FROM family_unions ORDER BY ordinal").all()).map(row => ({ id: String(row.id), participants: [String(row.participant_a), String(row.participant_b)] as [string, string], type: "partnership" as const }));
  return { revision, family: { title: "", description: "", demo: false, people, links, unions, photos: [] } satisfies Family };
}

async function readExportWarnings(db: StoreDatabase, ids: ReadonlySet<string>) {
  if (!ids.size) return { parentEvidence: false, catalogLinks: false };
  const scope = JSON.stringify([...ids]);
  const sqliteIds = "SELECT value FROM json_each(?)", postgresIds = "SELECT jsonb_array_elements_text(?::jsonb)";
  const result = await db.prepare(
    `SELECT EXISTS(SELECT 1 FROM relations WHERE type='parent' AND source IN (${sqliteIds}) AND target IN (${sqliteIds}) AND (COALESCE(confidence,'')<>'' OR json_array_length(COALESCE(sources,'[]'))>0)) AS parent_evidence,
      (EXISTS(SELECT 1 FROM people p,json_tree(json_remove(p.data,'$.parentClaims')) j WHERE p.id IN (${sqliteIds}) AND j.key='catalogId' AND j.type='text' AND j.value<>'') OR
       EXISTS(SELECT 1 FROM relations r,json_tree(COALESCE(r.sources,'[]')) j WHERE r.source IN (${sqliteIds}) AND r.target IN (${sqliteIds}) AND j.key='catalogId' AND j.type='text' AND j.value<>'') OR
       EXISTS(SELECT 1 FROM family_unions u,json_tree(u.data) j WHERE u.participant_a IN (${sqliteIds}) AND u.participant_b IN (${sqliteIds}) AND j.key='catalogId' AND j.type='text' AND j.value<>'')) AS catalog_links`,
    `SELECT EXISTS(SELECT 1 FROM relations WHERE type='parent' AND source IN (${postgresIds}) AND target IN (${postgresIds}) AND (COALESCE(confidence,'')<>'' OR jsonb_array_length(COALESCE(sources::jsonb,'[]'::jsonb))>0)) AS parent_evidence,
      (EXISTS(SELECT 1 FROM people WHERE id IN (${postgresIds}) AND jsonb_path_exists(data - 'parentClaims', '$.**.catalogId ? (@.type() == "string" && @ != "")')) OR
       EXISTS(SELECT 1 FROM relations WHERE source IN (${postgresIds}) AND target IN (${postgresIds}) AND jsonb_path_exists(COALESCE(sources::jsonb,'[]'::jsonb), '$.**.catalogId ? (@.type() == "string" && @ != "")')) OR
       EXISTS(SELECT 1 FROM family_unions WHERE participant_a IN (${postgresIds}) AND participant_b IN (${postgresIds}) AND jsonb_path_exists(data, '$.**.catalogId ? (@.type() == "string" && @ != "")'))) AS catalog_links`,
  ).get(...Array.from({ length: 7 }, () => scope));
  return { parentEvidence: Number(result?.parent_evidence) === 1, catalogLinks: Number(result?.catalog_links) === 1 };
}

export async function readArchiveOverview(db: StoreDatabase, includePortraits = true, visible?: ReadonlySet<string>) {
  const meta = await readArchiveMeta(db);
  const ids = visible ? JSON.stringify([...visible]) : undefined;
  const sqliteIds = "SELECT value FROM json_each(?)", postgresIds = "SELECT value FROM jsonb_array_elements_text(?::jsonb)";
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
       FROM people${visible ? ` WHERE id IN (${sqliteIds})` : ""} ORDER BY rowid`,
        `SELECT (data - ARRAY[${remove.map(() => "substring(?::text FROM 3)").join(",")}]::text[]) || '{"sources":[]}'::jsonb AS data FROM people${visible ? ` WHERE id IN (${postgresIds})` : ""} ORDER BY ordinal`,
      )
      .all(...remove, ...(ids === undefined ? [] : [ids]))
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
        `SELECT * FROM relations${visible ? ` WHERE source IN (${sqliteIds}) AND target IN (${sqliteIds})` : ""} ORDER BY rowid`,
        `SELECT * FROM relations${visible ? ` WHERE source IN (${postgresIds}) AND target IN (${postgresIds})` : ""} ORDER BY ordinal`,
      )
      .all(...(ids === undefined ? [] : [ids, ids])),
    people,
  );
  const unions = (
    await db
      .prepare(
        `SELECT data FROM family_unions${visible ? ` WHERE participant_a IN (${sqliteIds}) AND participant_b IN (${sqliteIds})` : ""} ORDER BY rowid`,
        `SELECT data FROM family_unions${visible ? ` WHERE participant_a IN (${postgresIds}) AND participant_b IN (${postgresIds})` : ""} ORDER BY ordinal`,
      )
      .all(...(ids === undefined ? [] : [ids, ids]))
  ).map((row) => JSON.parse(String(row.data)));
  const family: Family = {
    title: meta.title,
    description: meta.description,
    demo: meta.demo,
    people,
    ...(unions.length ? { unions } : {}),
    links,
    photos: [],
  };
  await hydrateCatalogCitations(db, family);
  return {
    family,
    revision: meta.revision,
    totals: { people: meta.people, photos: meta.photos },
  };
}

async function readPeoplePage(
  db: StoreDatabase,
  offset: number,
  limit: number,
  visible?: ReadonlySet<string>,
): Promise<Person[]> {
  const args = visible ? [JSON.stringify([...visible])] : [];
  const people = (
    await db
      .prepare(
        `SELECT data FROM people${visible ? " WHERE id IN (SELECT value FROM json_each(?))" : ""} ORDER BY rowid LIMIT ? OFFSET ?`,
        `SELECT data FROM people${visible ? " WHERE id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))" : ""} ORDER BY ordinal LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset)
  ).map(
    (row) =>
      ({
        ...JSON.parse(String(row.data)),
        parents: [],
        spouses: [],
      }) as Person,
  );
  await hydrateCatalogCitations(db, {
    title: "",
    description: "",
    demo: false,
    people,
  });
  return people;
}

type PhotoReadScope = { visible: ReadonlySet<string>; userId: string };
function photoReadWhere(
  scope?: PhotoReadScope,
  tagged?: ReadonlySet<string>,
  ids?: ReadonlySet<string>,
) {
  const sqlite: string[] = [],
    postgres: string[] = [],
    args: string[] = [];
  if (scope) {
    sqlite.push(
      "(json_extract(photos.data,'$.createdBy')=? OR EXISTS (SELECT 1 FROM photo_tags t WHERE t.photo_id=photos.id AND t.person_id IN (SELECT value FROM json_each(?))))",
    );
    postgres.push(
      "(photos.data->>'createdBy'=? OR EXISTS (SELECT 1 FROM photo_tags t WHERE t.archive_id=photos.archive_id AND t.photo_id=photos.id AND t.person_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))))",
    );
    args.push(scope.userId, JSON.stringify([...scope.visible]));
  }
  if (tagged) {
    sqlite.push(
      "EXISTS (SELECT 1 FROM photo_tags t WHERE t.photo_id=photos.id AND t.person_id IN (SELECT value FROM json_each(?)))",
    );
    postgres.push(
      "EXISTS (SELECT 1 FROM photo_tags t WHERE t.archive_id=photos.archive_id AND t.photo_id=photos.id AND t.person_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)))",
    );
    args.push(JSON.stringify([...tagged]));
  }
  if (ids) {
    const predicate = ids.size
      ? `photos.id IN (${[...ids].map(() => "?").join(",")})`
      : "0=1";
    sqlite.push(predicate);
    postgres.push(predicate);
    args.push(...ids);
  }
  return {
    sqlite: sqlite.length ? " WHERE " + sqlite.join(" AND ") : "",
    postgres: postgres.length ? " WHERE " + postgres.join(" AND ") : "",
    args,
  };
}
async function readPhotoPage(
  db: StoreDatabase,
  offset: number,
  limit: number,
  scope?: PhotoReadScope,
  tagged?: ReadonlySet<string>,
  ids?: ReadonlySet<string>,
): Promise<ArchivePhoto[]> {
  const where = photoReadWhere(scope, tagged, ids);
  const rows = await db
      .prepare(
        `SELECT id,data FROM photos${where.sqlite} ORDER BY rowid LIMIT ? OFFSET ?`,
        `SELECT id,data FROM photos${where.postgres} ORDER BY ordinal LIMIT ? OFFSET ?`,
      )
      .all(...where.args, limit, offset),
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
  for (const row of tags) {
    const tag = JSON.parse(String(row.data));
    if (!scope || scope.visible.has(tag.personId))
      photoMap.get(String(row.photo_id))?.tags.push(tag);
  }
  return photos;
}

export async function readArchive(db: StoreDatabase) {
  const meta = (await db
    .prepare(
      "SELECT * FROM archive WHERE id=1",
      "SELECT * FROM archives WHERE id=current_setting('drevo.archive_id', true)",
    )
    .get())!;
  // Backups made before schema v19 are read in query-only mode during restore.
  const hasUnions =
    db.kind === "postgres" ||
    !!(await db
      .prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='family_unions'",
      )
      .get());
  const snapshot = hydrateArchive(
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
    hasUnions
      ? await db
          .prepare(
            "SELECT data FROM family_unions ORDER BY rowid",
            "SELECT data FROM family_unions ORDER BY ordinal",
          )
          .all()
      : [],
  );
  await hydrateCatalogCitations(db, snapshot.family);
  return snapshot;
}
