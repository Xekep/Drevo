import type { openArchive } from "./database.ts";
import type { ArchiveUser, Source } from "../domain/index.ts";
import { isScopedUser } from "../domain/tree-access.ts";
import { scopedArchiveReader } from "./scoped-archive-reader.ts";
import { parseCatalogSource } from "../shared/source-catalog.ts";
import {
  sqliteVisibleCitationMediaSql,
  postgresVisibleCitationMediaSql,
} from "./media-reference-sql.ts";

/** Re-evaluate one URL against current rows; never cache a media authorization grant. */
export function mediaReferenceAccess(
  archive: Awaited<ReturnType<typeof openArchive>>,
) {
  const visibleIds = scopedArchiveReader(archive);
  return async (url: string, user: ArchiveUser) => {
    const visible = isScopedUser(user)
      ? JSON.stringify([...(await visibleIds(user))])
      : null;
    if (
      await archive.db
        .prepare(
          `WITH request AS (SELECT ? AS ids,? AS actor,? AS url)
       SELECT 1 FROM request q WHERE EXISTS(SELECT 1 FROM people p WHERE json_extract(p.data,'$.photo')=q.url
         AND (q.ids IS NULL OR p.id IN (SELECT value FROM json_each(q.ids))))
       OR EXISTS(SELECT 1 FROM photos p WHERE json_extract(p.data,'$.url')=q.url AND (q.ids IS NULL
         OR json_extract(p.data,'$.createdBy')=q.actor OR EXISTS(SELECT 1 FROM photo_tags t WHERE t.photo_id=p.id
           AND t.person_id IN (SELECT value FROM json_each(q.ids)))))`,
          `WITH request AS (SELECT ?::jsonb AS ids,?::text AS actor,?::text AS url)
       SELECT 1 FROM request q WHERE EXISTS(SELECT 1 FROM people p WHERE p.portrait_url=q.url
         AND (q.ids IS NULL OR p.id IN (SELECT value FROM jsonb_array_elements_text(q.ids))))
       OR EXISTS(SELECT 1 FROM photos p WHERE p.media_url=q.url AND (q.ids IS NULL
         OR p.data->>'createdBy'=q.actor OR EXISTS(SELECT 1 FROM photo_tags t WHERE t.archive_id=p.archive_id AND t.photo_id=p.id
           AND t.person_id IN (SELECT value FROM jsonb_array_elements_text(q.ids)))))`,
        )
        .get(visible, user.id, url)
    )
      return true;
    const match = await archive.db
      .prepare(sqliteVisibleCitationMediaSql, postgresVisibleCitationMediaSql)
      .get(visible, url);
    if (!match) return false;
    if (match.catalog_data) {
      const catalog = parseCatalogSource(
        JSON.parse(String(match.catalog_data)),
      );
      if (!catalog) throw new Error("Повреждён источник в каталоге");
      const citation = JSON.parse(String(match.citation)) as Source;
      if (
        citation.documentId &&
        !catalog.documentIds.includes(citation.documentId)
      )
        throw new Error("Документ цитаты отсутствует у источника");
    }
    return true;
  };
}
