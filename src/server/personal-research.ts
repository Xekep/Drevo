import { randomUUID } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";
import type {
  BookmarkTarget,
  PersonalBookmark,
  SavedPeopleFilter,
} from "../shared/personal-research.ts";
import type { Family, ArchiveUser } from "../domain/index.ts";
import { fullName } from "../domain/dates.ts";
import { isScopedUser } from "../domain/tree-access.ts";
import { archiveDocumentPath } from "../domain/archive-routes.ts";
import { archiveTargetPath } from "../domain/archive-links.ts";
import { filterResearchPeople } from "../domain/research-people-filter.ts";

export function bookmarkTarget(value: Record<string, unknown>): BookmarkTarget {
  if (
    !["person", "photo", "document"].includes(String(value.kind)) ||
    typeof value.id !== "string" ||
    !/^[\p{L}\p{N}_.:-]{1,200}$/u.test(value.id)
  )
    throw new Error("Некорректная закладка");
  return { kind: value.kind as BookmarkTarget["kind"], id: value.id };
}

/** Stored bookmarks contain IDs only. Names and visibility are resolved on read. */
export function personalResearchStore(db: StoreDatabase) {
  async function resolve(
    targets: BookmarkTarget[],
    family: Family,
    user: ArchiveUser,
  ): Promise<PersonalBookmark[]> {
    const people = new Map(family.people.map((p) => [p.id, fullName(p)]));
    const photos = new Map(
      (family.photos || []).map((p) => [p.id, p.title || "Фотография"]),
    );
    const documents = targets
      .filter((t) => t.kind === "document")
      .map((t) => t.id);
    const names = new Map<string, string>();
    if (documents.length) {
      const marks = documents.map(() => "?").join(",");
      const rows = await db
        .prepare(
          `SELECT d.id,d.title,d.uploaded_by,dp.person_id FROM documents d
         LEFT JOIN document_people dp ON dp.document_id=d.id WHERE d.id IN (${marks})`,
          `SELECT d.id,d.title,d.uploaded_by,dp.person_id FROM documents d
         LEFT JOIN document_people dp ON dp.archive_id=d.archive_id AND dp.document_id=d.id WHERE d.id IN (${marks})`,
        )
        .all(...documents);
      for (const row of rows)
        if (
          !isScopedUser(user) ||
          (row.person_id && people.has(String(row.person_id))) ||
          (!row.person_id && row.uploaded_by === user.id)
        )
          names.set(String(row.id), String(row.title));
    }
    return targets.flatMap((target) => {
      const label = (
        target.kind === "person"
          ? people
          : target.kind === "photo"
            ? photos
            : names
      ).get(target.id);
      return label
        ? [
            {
              ...target,
              label,
              href:
                target.kind === "document"
                  ? archiveDocumentPath(null, target.id)
                  : archiveTargetPath({ kind: target.kind, id: target.id }),
            },
          ]
        : [];
    });
  }
  return {
    resolve,
    async removeBookmarks(userId: string, targets: BookmarkTarget[]) {
      if (!targets.length) return;
      await db
        .prepare(
          `DELETE FROM personal_bookmarks WHERE user_id=? AND (kind,entity_id) IN (${targets.map(() => "(?,?)").join(",")})`,
          `DELETE FROM personal_bookmarks WHERE user_id=? AND (kind,entity_id) IN (${targets.map(() => "(?,?)").join(",")})`,
        )
        .run(userId, ...targets.flatMap((target) => [target.kind, target.id]));
    },
    async bookmarks(userId: string) {
      const rows = await db
        .prepare(
          "SELECT kind,entity_id FROM personal_bookmarks WHERE user_id=? ORDER BY created_ms DESC,kind,entity_id",
          "SELECT kind,entity_id FROM personal_bookmarks WHERE user_id=? ORDER BY created_ms DESC,kind,entity_id",
        )
        .all(userId);
      return rows.map((row) => ({
        kind: row.kind,
        id: row.entity_id,
      })) as BookmarkTarget[];
    },
    async bookmark(userId: string, target: BookmarkTarget, remove: boolean) {
      if (remove) {
        await db
          .prepare(
            "DELETE FROM personal_bookmarks WHERE user_id=? AND kind=? AND entity_id=?",
            "DELETE FROM personal_bookmarks WHERE user_id=? AND kind=? AND entity_id=?",
          )
          .run(userId, target.kind, target.id);
        return;
      }
      const previous = await db
        .prepare(
          "SELECT 1 AS present FROM personal_bookmarks WHERE user_id=? AND kind=? AND entity_id=?",
          "SELECT 1 AS present FROM personal_bookmarks WHERE user_id=? AND kind=? AND entity_id=?",
        )
        .get(userId, target.kind, target.id);
      if (previous) return;
      const count = await db
        .prepare(
          "SELECT count(*) AS n FROM personal_bookmarks WHERE user_id=?",
          "SELECT count(*) AS n FROM personal_bookmarks WHERE user_id=?",
        )
        .get(userId);
      if (Number(count?.n) >= 200)
        throw new Error("Можно сохранить до 200 закладок в одном древе");
      await db
        .prepare(
          "INSERT INTO personal_bookmarks(user_id,kind,entity_id,created_ms) VALUES(?,?,?,?)",
          "INSERT INTO personal_bookmarks(user_id,kind,entity_id,created_ms) VALUES(?,?,?,?)",
        )
        .run(userId, target.kind, target.id, Date.now());
    },
    async filters(userId: string): Promise<SavedPeopleFilter[]> {
      const rows = await db
        .prepare(
          "SELECT id,name,criteria FROM personal_people_filters WHERE user_id=? ORDER BY created_ms DESC,id",
          "SELECT id,name,criteria FROM personal_people_filters WHERE user_id=? ORDER BY created_ms DESC,id",
        )
        .all(userId);
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        criteria:
          typeof row.criteria === "string"
            ? JSON.parse(row.criteria)
            : row.criteria,
      }));
    },
    async saveFilter(
      userId: string,
      name: unknown,
      criteria: unknown,
      family: Family,
    ) {
      if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
        throw new Error("Название поиска должно содержать от 1 до 80 символов");
      filterResearchPeople(family, criteria, "include");
      const count = await db
        .prepare(
          "SELECT count(*) AS n FROM personal_people_filters WHERE user_id=?",
          "SELECT count(*) AS n FROM personal_people_filters WHERE user_id=?",
        )
        .get(userId);
      if (Number(count?.n) >= 30)
        throw new Error("Можно сохранить до 30 поисков в одном древе");
      const id = randomUUID();
      await db
        .prepare(
          "INSERT INTO personal_people_filters(user_id,id,name,criteria,created_ms) VALUES(?,?,?,?,?)",
          "INSERT INTO personal_people_filters(user_id,id,name,criteria,created_ms) VALUES(?,?,?,?,?)",
        )
        .run(userId, id, name.trim(), JSON.stringify(criteria), Date.now());
      return id;
    },
    async deleteFilter(userId: string, id: unknown) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
        throw new Error("Некорректный поиск");
      await db
        .prepare(
          "DELETE FROM personal_people_filters WHERE user_id=? AND id=?",
          "DELETE FROM personal_people_filters WHERE user_id=? AND id=?",
        )
        .run(userId, id);
    },
  };
}
