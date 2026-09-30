import type { StoreDatabase } from "./store-database.ts";
import type { Role, ArchiveUser } from "../domain/access.ts";
import { ROLE_NAMES } from "../domain/access.ts";
import {
  DEFAULT_STORAGE_LIMITS,
  parseStorageLimits,
  type StorageLimits,
} from "../shared/storage-limits.ts";
import { auditStore } from "./audit.ts";
import { UploadQuotaError } from "./upload-quota-error.ts";

export async function readStorageLimits(
  db: StoreDatabase,
): Promise<StorageLimits> {
  const row = await db
    .prepare(
      "SELECT data FROM upload_limits WHERE id=1",
      "SELECT data FROM upload_limits WHERE id=1",
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
        EXISTS (SELECT 1 FROM media_upload_grants g WHERE g.url=m.url AND g.expires_ms>?)
      )),0) AS bytes`,
      `SELECT COALESCE((SELECT sum(file_size) FROM documents WHERE uploaded_by=?),0) +
      COALESCE((SELECT sum(m.size_bytes) FROM media_originals m WHERE m.uploaded_by=? AND (
        EXISTS (SELECT 1 FROM people p WHERE p.archive_id=m.archive_id AND p.data->>'photo'=m.url) OR
        EXISTS (SELECT 1 FROM photos p WHERE p.archive_id=m.archive_id AND p.data->>'url'=m.url) OR
        EXISTS (SELECT 1 FROM media_upload_grants g WHERE g.archive_id=m.archive_id AND g.url=m.url AND g.expires_ms>?)
      )),0) AS bytes`,
    )
    .get(userId, userId, now);
  return Number(row?.bytes || 0);
}

export async function enforceUserStorageLimit(
  db: StoreDatabase,
  userId: string,
  extraBytes = 0,
  includeReservations = false,
  now = Date.now(),
) {
  const row = await db
    .prepare(
      "SELECT role FROM users WHERE id=?",
      "SELECT role FROM runtime_users WHERE id=?",
    )
    .get(userId);
  const role = row?.role as Role | undefined;
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
  if (
    (await userStorageBytes(db, userId, now)) + pending + extraBytes >
    limit * 1024 ** 2
  )
    throw new UploadQuotaError(
      `Личный лимит фотографий и PDF — ${limit} МБ. Освободите место или обратитесь к администратору.`,
      507,
    );
}
