import type { StoreDatabase } from "./store-database.ts";
import { postgresMediaReferencesSql } from "./media-reference-sql.ts";
import type { Role, ArchiveUser } from "../domain/access.ts";
import { ROLE_NAMES } from "../domain/access.ts";
import {
  DEFAULT_STORAGE_LIMITS,
  parseStorageLimits,
  type StorageLimits,
} from "../shared/storage-limits.ts";
import { auditStore } from "./audit.ts";
import { UploadQuotaError } from "./upload-quota-error.ts";
import type pg from "pg";

export async function readStorageLimits(
  db: StoreDatabase,
): Promise<StorageLimits> {
  const row = await db
    .prepare(
      "SELECT data FROM upload_limits WHERE id=1",
      "SELECT data FROM platform_upload_limits WHERE id=1",
    )
    .get();
  return row
    ? parseStorageLimits(JSON.parse(String(row.data)))!
    : { ...DEFAULT_STORAGE_LIMITS };
}

/** Called inside the same archive transaction as the authorization check. */
export async function writeStorageLimits(
  db: StoreDatabase,
  limits: StorageLimits,
  actor: ArchiveUser,
) {
  if (db.kind === "postgres")
    throw new Error("Platform storage limits require a platform transaction");
  const before = await readStorageLimits(db);
  await db
    .prepare(
      "INSERT INTO upload_limits(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      "INSERT INTO upload_limits(id,data) VALUES(1,?) ON CONFLICT(archive_id,id) DO UPDATE SET data=excluded.data",
    )
    .run(JSON.stringify(limits));
  const label = (value: number | null) =>
    value === null ? "Без личного лимита" : `${value} МБ`;
  await auditStore(db).record(
    {
      action: "Изменены лимиты загрузок",
      entity: "settings",
      entityId: "upload-limits",
      label: "Хранилище по ролям",
      personIds: [],
      details: (Object.keys(limits) as Role[])
        .filter((role) => before[role] !== limits[role])
        .map((role) => ({
          field: ROLE_NAMES[role],
          before: label(before[role]),
          after: label(limits[role]),
        })),
    },
    actor,
  );
}

/** The caller holds the current platform grant and session locks. */
export async function writePlatformStorageLimits(
  client: pg.PoolClient,
  limits: StorageLimits,
  actorId: string,
) {
  await client.query(
    `INSERT INTO platform_upload_limits(id,data) VALUES(1,$1)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
    [JSON.stringify(limits)],
  );
  await client.query(
    `INSERT INTO platform_config_audit(actor_id,action,item_id)
     VALUES($1,'storage_limits_changed','upload-limits')`,
    [actorId],
  );
}

/** Count each original once. Unattached portraits count until their grant expires.
 * Legacy files without provenance stay covered by the shared archive quota. */
export async function userStorageBytes(
  db: StoreDatabase,
  userId: string,
  now = Date.now(),
) {
  const row = await db
    .prepare(
      `SELECT COALESCE((SELECT sum(file_size) FROM documents WHERE uploaded_by=?),0) +
      COALESCE((SELECT sum(m.size_bytes) FROM media_originals m WHERE m.uploaded_by=? AND (
        EXISTS (SELECT 1 FROM people p WHERE json_extract(p.data,'$.photo')=m.url) OR
        EXISTS (SELECT 1 FROM photos p WHERE json_extract(p.data,'$.url')=m.url) OR
        EXISTS (SELECT 1 FROM people p,json_tree(p.data) j WHERE j.key='url' AND
          (j.value=m.url OR j.value LIKE m.url||'#%' OR j.value LIKE m.url||'?%')) OR
        EXISTS (SELECT 1 FROM family_unions u,json_tree(u.data) j WHERE j.key='url' AND
          (j.value=m.url OR j.value LIKE m.url||'#%' OR j.value LIKE m.url||'?%')) OR
        EXISTS (SELECT 1 FROM relations r,json_tree(r.sources) j WHERE j.key='url' AND
          (j.value=m.url OR j.value LIKE m.url||'#%' OR j.value LIKE m.url||'?%')) OR
        EXISTS (SELECT 1 FROM media_upload_grants g WHERE g.url=m.url AND g.expires_ms>?)
      )),0) + COALESCE((SELECT sum(json_extract(f.value,'$.size')) FROM person_comments c,json_each(c.attachments) f WHERE c.author_id=?),0) AS bytes`,
      `SELECT COALESCE((SELECT sum(file_size) FROM documents WHERE uploaded_by=?),0) +
      COALESCE((SELECT sum(m.size_bytes) FROM media_originals m WHERE m.uploaded_by=? AND (
        EXISTS (SELECT 1 FROM (${postgresMediaReferencesSql}) r WHERE r.url=m.url) OR
        EXISTS (SELECT 1 FROM media_upload_grants g WHERE g.archive_id=m.archive_id AND g.url=m.url AND g.expires_ms>?)
      )),0) + COALESCE((SELECT sum((f->>'size')::bigint) FROM person_comments c,jsonb_array_elements(c.attachments) f WHERE c.author_id=?),0) AS bytes`,
    )
    .get(userId, userId, now, userId);
  return Number(row?.bytes || 0);
}

/** previousBytes is only for an already-accounted reference update in the same
 * transaction; upload and import paths must enforce the full resulting usage. */
export async function enforceUserStorageLimit(
  db: StoreDatabase,
  userId: string,
  extraBytes = 0,
  includeReservations = false,
  now = Date.now(),
  previousBytes?: number,
) {
  const row = await db.prepare(
    "SELECT role FROM users WHERE id=?",
    `SELECT m.role,
       o.user_id IS NOT NULL AS owner,
       pa.account_id IS NOT NULL AS platform_admin,
       pr.account_id IS NOT NULL AS platform_researcher
     FROM archive_memberships m
     LEFT JOIN archive_owners o ON o.archive_id=m.archive_id AND o.user_id=m.user_id
     LEFT JOIN platform_admins pa ON pa.account_id=m.user_id
     LEFT JOIN platform_researchers pr ON pr.account_id=m.user_id
     WHERE m.user_id=?`,
  ).get(userId);
  const role: Role | undefined = db.kind === "sqlite" ?
    row?.role as Role | undefined : !row ? undefined :
    row.role === "reader" && !row.owner ? "reader" :
    row.platform_admin ? "admin" :
    row.platform_researcher ? "researcher" : "relative";
  const limits = await readStorageLimits(db);
  const limit = role ? limits[role] : userId === "local" ? limits.admin : null;
  if (limit === null || limit === undefined) return;
  const pending = includeReservations
    ? Number(
        (
          await db
            .prepare(
              "SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM document_upload_requests WHERE user_id=? AND expires_ms>?",
              "SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM document_upload_requests WHERE user_id=? AND expires_ms>?",
            )
            .get(userId, now)
        )?.bytes || 0,
      )
    : 0;
  const used = (await userStorageBytes(db, userId, now)) + pending + extraBytes;
  if (used > limit * 1024 ** 2 &&
      (previousBytes === undefined || used > previousBytes))
    throw new UploadQuotaError(
      `Личный лимит файлов — ${limit} МБ. Освободите место или обратитесь к администратору.`,
      507,
    );
}
