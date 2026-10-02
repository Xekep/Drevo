import type { StoreDatabase } from "./store-database.ts";
import { randomUUID } from "node:crypto";

import { UploadQuotaError } from "./upload-quota-error.ts";
import { enforceUserStorageLimit } from "./storage-limits.ts";
import { PLATFORM_DISK_LOCK } from "./platform-disk-reservation.ts";
export { UploadQuotaError } from "./upload-quota-error.ts";

const RESERVATION_MS = 10 * 60_000;

/** Reservations count unfinished uploads, including requests in other processes. */
export function uploadQuota(
  db: StoreDatabase,
  {
    bytes = 10 * 1024 ** 3,
    files = 20_000,
    requestsPerHour = 60,
    concurrent = 16,
    freeReserve = 256 * 1024 ** 2,
    reservationMs = RESERVATION_MS,
    renewEveryMs = 0,
    now = Date.now,
  } = {},
) {
  if (renewEveryMs && (renewEveryMs < 1 || renewEveryMs >= reservationMs))
    throw new Error("Некорректный интервал продления резерва");
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
      await db.transaction(async () => {
        await db
          .prepare(
            "DELETE FROM document_upload_requests WHERE started_ms<? AND (reserved_bytes=0 OR expires_ms<?)",
            "DELETE FROM document_upload_requests WHERE started_ms<? AND (reserved_bytes=0 OR expires_ms<?)",
          )
          .run(time - 3600_000, time);
        await db
          .prepare(
            "UPDATE document_upload_requests SET reserved_bytes=0 WHERE expires_ms<?",
            "UPDATE document_upload_requests SET reserved_bytes=0 WHERE expires_ms<?",
          )
          .run(time);
        const recent = Number(
          (await db
            .prepare(
              "SELECT count(*) AS n FROM document_upload_requests WHERE user_id=? AND started_ms>=?",
              "SELECT count(*) AS n FROM document_upload_requests WHERE user_id=? AND started_ms>=?",
            )
            .get(userId, time - 3600_000))!.n,
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
            `SELECT (SELECT count(*) FROM documents)+(SELECT count(*) FROM person_comments c,json_each(c.attachments)) AS n,
              coalesce((SELECT sum(file_size) FROM documents),0)+coalesce((SELECT sum(json_extract(f.value,'$.size')) FROM person_comments c,json_each(c.attachments) f),0) AS bytes`,
            `SELECT (SELECT count(*) FROM documents)+(SELECT count(*) FROM person_comments c,jsonb_array_elements(c.attachments)) AS n,
              coalesce((SELECT sum(file_size) FROM documents),0)+coalesce((SELECT sum((f->>'size')::bigint) FROM person_comments c,jsonb_array_elements(c.attachments) f),0) AS bytes`,
          )
          .get())!;
        // The file scan and the free-space check must observe the state after
        // acquiring the shared lock. A scan taken while waiting for another
        // process could miss originals that it has just finished uploading.
        if (db.kind === "postgres") {
          await db
            .prepare("", "SELECT pg_advisory_xact_lock(?)")
            .get(PLATFORM_DISK_LOCK);
          await db
            .prepare(
              "",
              "DELETE FROM platform_upload_reservations WHERE expires_ms<?",
            )
            .run(time);
        }
        const currentImages =
          typeof images === "function" ? await images() : images;
        const currentFreeBytes =
          typeof freeBytes === "function" ? await freeBytes() : freeBytes;
        const platformPending =
          db.kind === "postgres"
            ? Number(
                (
                  await db
                    .prepare(
                      "",
                      "SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM platform_upload_reservations",
                    )
                    .get()
                )?.bytes || 0,
              )
            : Number(pending.bytes);
        if (
          currentImages.files + Number(used.n) + Number(pending.n) >= files ||
          currentImages.bytes +
            Number(used.bytes) +
            Number(pending.bytes) +
            maximumBytes >
            bytes ||
          currentFreeBytes - platformPending - maximumBytes < freeReserve
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
          .run(id, userId, time, time + reservationMs, maximumBytes);
        if (db.kind === "postgres")
          await db
            .prepare(
              "",
              "INSERT INTO platform_upload_reservations(id,reserved_bytes,expires_ms) VALUES(?,?,?)",
            )
            .run(id, maximumBytes, time + reservationMs);
      });
      let renewing: Promise<void> | undefined;
      let stopped = false;
      const timer = renewEveryMs
        ? setInterval(() => {
            if (stopped || renewing) return;
            renewing = db
              .transaction(async () => {
                const time = now();
                const local = await db
                  .prepare(
                    "UPDATE document_upload_requests SET expires_ms=? WHERE id=? AND reserved_bytes>0 AND expires_ms>?",
                    "UPDATE document_upload_requests SET expires_ms=? WHERE id=? AND reserved_bytes>0 AND expires_ms>?",
                  )
                  .run(time + reservationMs, id, time);
                if (local.changes !== 1)
                  throw new Error("Upload reservation expired");
                if (db.kind === "postgres") {
                  const shared = await db
                    .prepare(
                      "",
                      "UPDATE platform_upload_reservations SET expires_ms=? WHERE id=? AND expires_ms>?",
                    )
                    .run(time + reservationMs, id, time);
                  if (shared.changes !== 1)
                    throw new Error("Platform reservation expired");
                }
              })
              .catch(() => console.warn("upload_reservation_renew_failed"))
              .finally(() => {
                renewing = undefined;
              });
          }, renewEveryMs)
        : undefined;
      timer?.unref();
      const release = async () => {
        stopped = true;
        if (timer) clearInterval(timer);
        await renewing;
        await db.transaction(async () => {
          await db
            .prepare(
              "UPDATE document_upload_requests SET reserved_bytes=0 WHERE id=?",
              "UPDATE document_upload_requests SET reserved_bytes=0 WHERE id=?",
            )
            .run(id);
          if (db.kind === "postgres")
            await db
              .prepare(
                "",
                "DELETE FROM platform_upload_reservations WHERE id=?",
              )
              .run(id);
        });
      };
      return Object.assign(release, {
        async assertValid() {
          await renewing;
          const time = now();
          const local = await db
            .prepare(
              "SELECT 1 AS valid FROM document_upload_requests WHERE id=? AND reserved_bytes>0 AND expires_ms>?",
              "SELECT 1 AS valid FROM document_upload_requests WHERE id=? AND reserved_bytes>0 AND expires_ms>?",
            )
            .get(id, time);
          const shared = db.kind === "postgres"
            ? await db
                .prepare(
                  "",
                  "SELECT 1 AS valid FROM platform_upload_reservations WHERE id=? AND expires_ms>?",
                )
                .get(id, time)
            : { valid: 1 };
          if (!local || !shared)
            throw new UploadQuotaError(
              "Резерв места истёк. Повторите импорт.",
              507,
            );
        },
      });
    },
  };
}
