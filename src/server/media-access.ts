import { enforceUserStorageLimit } from "./storage-limits.ts";
import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveUser } from "../domain/access.ts";
import type { Family, Person, Source } from "../domain/types.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { allCitations, personCitations, unionCitations } from "./source-catalog-store.ts";
import { ForbiddenError } from "./users.ts";
import { recordMediaOriginal } from "./media-originals.ts";
import { enforcePostgresMediaQuota } from "./postgres-media-quota.ts";
import { postgresVisibleCitationMediaSql, sqliteVisibleCitationMediaSql } from "./media-reference-sql.ts";
import { parseCatalogSource } from "../shared/source-catalog.ts";

/** Provenance for a newly uploaded file before it is attached to a card. */
export async function registerMediaUpload(
  db: StoreDatabase,
  url: string,
  userId: string,
  sizeBytes: number,
  options: { withinTransaction?: boolean } = {},
) {
  const register = async () => {
    await db
      .prepare(
        "DELETE FROM media_upload_grants WHERE expires_ms<?",
        "DELETE FROM media_upload_grants WHERE expires_ms<?",
      )
      .run(Date.now());
    await recordMediaOriginal(db, url, sizeBytes, userId);
    await db
      .prepare(
        "INSERT INTO media_upload_grants(url,user_id,expires_ms) VALUES(?,?,?)",
        "INSERT INTO media_upload_grants(url,user_id,expires_ms) VALUES(?,?,?)",
      )
      .run(url, userId, Date.now() + 24 * 60 * 60_000);
    await enforcePostgresMediaQuota(db);
    await enforceUserStorageLimit(db, userId);
  };
  if (options.withinTransaction) {
    if (!db.inTransaction()) throw new Error("Media registration requires an archive transaction");
    await register();
  } else await db.transaction(register);
  return async () =>
    await db.transaction(async () => {
      await db
        .prepare(
          "DELETE FROM media_upload_grants WHERE url=?",
          "DELETE FROM media_upload_grants WHERE url=?",
        )
        .run(url);
      await db
        .prepare(
          "DELETE FROM media_originals WHERE url=?",
          "DELETE FROM media_originals WHERE url=?",
        )
        .run(url);
    });
}

export async function ownsPendingMedia(
  db: StoreDatabase,
  url: string,
  userId: string,
) {
  return !!(await db
    .prepare(
      "SELECT 1 FROM media_upload_grants WHERE url=? AND user_id=? AND expires_ms>?",
      "SELECT 1 FROM media_upload_grants WHERE url=? AND user_id=? AND expires_ms>?",
    )
    .get(url, userId, Date.now()));
}

/** Adding a reference must never grant access to a previously hidden file. */
export async function authorizeMediaReferences(
  db: StoreDatabase,
  before: Family,
  after: Family,
  user: ArchiveUser,
  options: { persistedVisibleIds?: ReadonlySet<string> } = {},
) {
  if (!isScopedUser(user)) return;
  const visible = projectFamilyForUser(before, user);
  const citationUrl = (url?: string) => {
    const original = url?.split(/[?#]/, 1)[0];
    return original?.startsWith("/media/") ? original : undefined;
  };
  const allowed = new Set([
    ...visible.people.map((p) => p.photo).filter((url): url is string => !!url),
    ...(visible.photos || []).map((p) => p.url),
    ...allCitations(visible).map((source) => citationUrl(source.url))
      .filter((url): url is string => !!url),
  ]);
  // Delta writes carry full citation/album records only for their targets.
  // Resolve a newly attached URL against the current persisted visibility,
  // without hydrating every album or every visible person's biography/sources.
  const persistedAllowed = async (url: string) => {
    if (!options.persistedVisibleIds) return false;
    const ids = JSON.stringify([...options.persistedVisibleIds]);
    if (await db.prepare(
      `SELECT 1 FROM photos p WHERE json_extract(p.data,'$.url')=?
        AND (json_extract(p.data,'$.createdBy')=? OR EXISTS (SELECT 1 FROM photo_tags t
          WHERE t.photo_id=p.id AND t.person_id IN (SELECT value FROM json_each(?)))) LIMIT 1`,
      `SELECT 1 FROM photos p WHERE p.media_url=?
        AND (p.data->>'createdBy'=? OR EXISTS (SELECT 1 FROM photo_tags t
          WHERE t.photo_id=p.id AND t.person_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)))) LIMIT 1`,
    ).get(url, user.id, ids)) return true;
    const match = await db.prepare(sqliteVisibleCitationMediaSql, postgresVisibleCitationMediaSql).get(ids, url);
    if (match?.catalog_data) {
      const catalog = parseCatalogSource(JSON.parse(String(match.catalog_data)));
      if (!catalog) throw new Error("Повреждён источник в каталоге");
      const citation = JSON.parse(String(match.citation)) as Source;
      if (citation.documentId && !catalog.documentIds.includes(citation.documentId))
        throw new Error("Документ цитаты отсутствует у источника");
    }
    return !!match;
  };
  const ownInverseValues = async (personId: string, field: "photo" | "sources") =>
    await db.prepare(
      `SELECT json_extract(c.value,'$.after') AS value FROM history h,
        json_each(h.data,'$.changes') c WHERE json_extract(h.data,'$.format')='drevo-archive-changes-v1'
        AND EXISTS (SELECT 1 FROM json_each(h.data,'$.owners') o WHERE o.key=? AND o.value=?)
        AND json_extract(c.value,'$.collection')='people' AND json_extract(c.value,'$.id')=?
        AND json_extract(c.value,'$.field')=?`,
      `SELECT c.value->>'after' AS value FROM history h
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(h.data->'changes','[]'::jsonb)) c(value)
        WHERE h.data->>'format'='drevo-archive-changes-v1' AND h.data->'owners'->>?=?
          AND c.value->>'collection'='people' AND c.value->>'id'=? AND c.value->>'field'=?`,
    ).all(personId, user.id, personId, field);
  const inverseSource = async (personId: string, url: string) =>
    (await ownInverseValues(personId, "sources")).some(row => {
      const sources: Source[] | null = row.value ? JSON.parse(String(row.value)) : null;
      return Array.isArray(sources) && sources.some(source => citationUrl(source.url) === url);
    });
  const ownHistoricalPersonSource = async (personId: string, url: string) =>
    await inverseSource(personId, url) || !!(await db.prepare(
      `SELECT 1 FROM media_originals m WHERE m.url=? AND m.uploaded_by=?
       AND EXISTS (
         SELECT 1 FROM history h,json_each(h.data,'$.people') p,
           json_each(p.value,'$.sources') s
         WHERE json_extract(p.value,'$.id')=?
           AND json_extract(p.value,'$.createdBy')=?
           AND (json_extract(s.value,'$.url')=m.url
             OR substr(json_extract(s.value,'$.url'),1,length(m.url)+1)
               IN (m.url||'#',m.url||'?'))
       ) LIMIT 1`,
      `SELECT 1 FROM media_originals m WHERE m.url=? AND m.uploaded_by=?
       AND EXISTS (
         SELECT 1 FROM history h
         CROSS JOIN LATERAL jsonb_array_elements(CASE
           WHEN jsonb_typeof(h.data->'people')='array' THEN h.data->'people'
           ELSE '[]'::jsonb END) p(value)
         CROSS JOIN LATERAL jsonb_array_elements(CASE
           WHEN jsonb_typeof(p.value->'sources')='array' THEN p.value->'sources'
           ELSE '[]'::jsonb END) s(value)
         WHERE p.value->>'id'=? AND p.value->>'createdBy'=?
           AND split_part(split_part(s.value->>'url','#',1),'?',1)=m.url
       ) LIMIT 1`,
    ).get(url, user.id, personId, user.id));
  const check = async (
    url?: string,
    previousPerson?: Person,
    ownPersonSourceRestore?: () => Promise<boolean>,
  ) => {
    if (
      url?.startsWith("/media/") &&
      !allowed.has(url) &&
      !(await persistedAllowed(url)) &&
      !(await ownsPendingMedia(db, url, user.id))
    ) {
      // Inverse journals prove the card owner as well as its previous field.
      // Full snapshots are read only for restoration from older releases.
      if (
        previousPerson?.createdBy === user.id &&
        ((await ownInverseValues(previousPerson.id, "photo")).some(row => row.value === url) || await db
          .prepare(
            `
        SELECT 1 FROM history h,json_each(h.data,'$.people') p
        WHERE json_extract(p.value,'$.id')=?
          AND json_extract(p.value,'$.createdBy')=?
          AND json_extract(p.value,'$.photo')=? LIMIT 1
      `,
            "SELECT 1 FROM history h CROSS JOIN LATERAL jsonb_array_elements(COALESCE(h.data->'people','[]'::jsonb)) p(value) WHERE p.value->>'id'=? AND p.value->>'createdBy'=? AND p.value->>'photo'=? LIMIT 1",
          )
          .get(previousPerson.id, user.id, url))
      )
        return;
      if (ownPersonSourceRestore && await ownPersonSourceRestore()) return;
      throw new ForbiddenError("Нет доступа к выбранному изображению");
    }
  };
  const people = new Map(before.people.map((p) => [p.id, p]));
  for (const p of after.people)
    if (p.photo !== people.get(p.id)?.photo)
      await check(p.photo, people.get(p.id));
  const photos = new Map((before.photos || []).map((p) => [p.id, p.url]));
  for (const p of after.photos || [])
    if (p.url !== photos.get(p.id)) await check(p.url);

  // A citation on one hidden entity must not be transferable to another
  // entity merely because both live in the same full archive snapshot.
  const addedCitations = async (
    previous: Array<{ url?: string }>,
    next: Array<{ url?: string }>,
    ownPersonSourceRestore?: (url: string) => Promise<boolean>,
  ) => {
    const existing = new Set(previous.map((source) => citationUrl(source.url)));
    for (const url of new Set(next.map((source) => citationUrl(source.url)))) {
      if (url && !existing.has(url))
        await check(url, undefined, ownPersonSourceRestore
          ? () => ownPersonSourceRestore(url) : undefined);
    }
  };
  const previousPeople = new Map(before.people.map((person) => [person.id, person]));
  for (const person of after.people) {
    const previous = previousPeople.get(person.id);
    // A visible child can retain a citation on a hidden parent edge. That
    // binding stays with the edge, not with every citation on the child card.
    await addedCitations(
      previous ? personCitations({ ...previous, parentClaims: [] }) : [],
      personCitations({ ...person, parentClaims: [] }),
      async (url) => {
        if (previous?.createdBy !== user.id || person.createdBy !== user.id ||
          !person.sources.some((source) => citationUrl(source.url) === url))
          return false;
        // A URL restored on the card may not be introduced on an event,
        // award, claim, or other slot in the same write.
        const otherSlots = personCitations({ ...person, sources: [], parentClaims: [] });
        if (otherSlots.some((source) => citationUrl(source.url) === url)) return false;
        return await ownHistoricalPersonSource(person.id, url);
      },
    );
    const previousParents = new Map((previous?.parentClaims || [])
      .map((claim) => [claim.parentId, claim]));
    for (const claim of person.parentClaims || [])
      await addedCitations(previousParents.get(claim.parentId)?.sources || [], claim.sources || []);
  }
  const previousUnions = new Map((before.unions || []).map((union) => [union.id, union]));
  for (const union of after.unions || []) {
    const previous = previousUnions.get(union.id);
    await addedCitations(previous ? unionCitations(previous) : [], unionCitations(union));
  }
  const previousLinks = new Map((before.links || []).map((link) => [link.id, link]));
  for (const link of after.links || [])
    await addedCitations(previousLinks.get(link.id)?.sources || [], link.sources || []);
}
