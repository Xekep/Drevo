import type { StoreDatabase } from "./store-database.ts";
import { randomUUID } from "node:crypto";

import { UploadQuotaError } from "./upload-quota-error.ts";
import { enforceUserStorageLimit } from "./storage-limits.ts";
export { UploadQuotaError } from "./upload-quota-error.ts";

/** Reservations count unfinished uploads, including requests in other processes. */
export function uploadQuota(
  db: StoreDatabase,
  {
    bytes = 10 * 1024 ** 3,
    files = 20_000,
    requestsPerHour = 60,
    concurrent = 16,
    freeReserve = 256 * 1024 ** 2,
    now = Date.now,
  } = {},
) {
  return {
    async acquire(
      userId: string,
      maximumBytes: number,
      freeBytes: number | (() => Promise<number>),
      images:
        | { files: number; bytes: number }
        | (() => Promise<{ files: number; bytes: number }>) =
        { files: 0, bytes: 0 },
    ) {
      const time = now(),
        id = randomUUID();
      return await db.transaction(async () => {
        await db
          .prepare(
            "DELETE FROM document_upload_requests WHERE started_ms<?",
            "DELETE FROM document_upload_requests WHERE started_ms<?",
          )
          .run(time - 3600_000);
        await db
          .prepare(
            "UPDATE document_upload_requests SET reserved_bytes=0 WHERE expires_ms<?",
            "UPDATE document_upload_requests SET reserved_bytes=0 WHERE expires_ms<?",
          )
          .run(time);
        const recent = Number(
          (await db
            .prepare(
              "SELECT count(*) AS n FROM document_upload_requests WHERE user_id=?",
              "SELECT count(*) AS n FROM document_upload_requests WHERE user_id=?",
            )
            .get(userId))!.n,
        );
        const pending = (await db
          .prepare(
            "SELECT count(*) AS n,coalesce(sum(reserved_bytes),0) AS bytes FROM document_upload_requests WHERE reserved_bytes>0",
            "SELECT count(*) AS n,coalesce(sum(reserved_bytes),0) AS bytes FROM document_upload_requests WHERE reserved_bytes>0",
          )
          .get())!;
        if (recent >= requestsPerHour || Number(pending.n) >= concurrent)
          throw new UploadQuotaError(
            "Слишком много загрузок. Попробуйте позже.",
            429,
          );
        const used = (await db
          .prepare(
            "SELECT count(*) AS n,coalesce(sum(file_size),0) AS bytes FROM documents",
            "SELECT count(*) AS n,coalesce(sum(file_size),0) AS bytes FROM documents",
          )
          .get())!;
        // The archive transaction serializes reservations. Read the disk only
        // after entering it, so a second process sees the first one's files.
        const currentFreeBytes =
          typeof freeBytes === "function" ? await freeBytes() : freeBytes;
        const currentImages =
          typeof images === "function" ? await images() : images;
        if (
          currentImages.files + Number(used.n) + Number(pending.n) >= files ||
          currentImages.bytes +
            Number(used.bytes) +
            Number(pending.bytes) +
            maximumBytes >
            bytes ||
          currentFreeBytes - Number(pending.bytes) - maximumBytes < freeReserve
        )
          throw new UploadQuotaError(
            "Недостаточно места. Лимит хранилища достигнут.",
            507,
          );
        await enforceUserStorageLimit(db, userId, maximumBytes, true, time);
        await db
          .prepare(
            "INSERT INTO document_upload_requests(id,user_id,started_ms,expires_ms,reserved_bytes) VALUES(?,?,?,?,?)",
            "INSERT INTO document_upload_requests(id,user_id,started_ms,expires_ms,reserved_bytes) VALUES(?,?,?,?,?)",
          )
          .run(id, userId, time, time + 300_000, maximumBytes);

        return async () =>
          await db
            .prepare(
              "UPDATE document_upload_requests SET reserved_bytes=0 WHERE id=?",
              "UPDATE document_upload_requests SET reserved_bytes=0 WHERE id=?",
            )
            .run(id);
      });
    },
  };
}
