import { randomUUID } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";
import { UploadQuotaError } from "./upload-quota-error.ts";

/** All archive uploads and temporary package work share this PostgreSQL lock. */
export const PLATFORM_DISK_LOCK = 186743293;

/** Temporary bytes are reserved only while they are still to be written.
 * Once the file is complete, statfs accounts for it and the lease is released.
 */
export async function reservePlatformDisk(
  db: StoreDatabase,
  bytes: number,
  freeBytes: () => Promise<number>,
  {
    freeReserve = 256 * 1024 ** 2,
    reservationMs = 30 * 60_000,
    renewEveryMs = 60_000,
    now = Date.now,
  } = {},
) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error("Некорректный размер резерва диска");
  const id = randomUUID();
  const check = async (additional: number, pending: number) => {
    if ((await freeBytes()) - pending - additional < freeReserve)
      throw new UploadQuotaError("Недостаточно места для проверки архива", 507);
  };
  if (db.kind === "postgres")
    await db.transaction(async () => {
      await db.prepare("", "SELECT pg_advisory_xact_lock(?)").get(PLATFORM_DISK_LOCK);
      const time = now();
      await db.prepare("", "DELETE FROM platform_upload_reservations WHERE expires_ms<?").run(time);
      const pending = Number((await db.prepare("", "SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM platform_upload_reservations").get())?.bytes || 0);
      await check(bytes, pending);
      await db.prepare("", "INSERT INTO platform_upload_reservations(id,reserved_bytes,expires_ms) VALUES(?,?,?)").run(id, bytes, time + reservationMs);
    });
  else await check(bytes, 0);

  let renewing: Promise<void> | undefined;
  let stopped = false;
  const timer = db.kind === "postgres" && renewEveryMs
    ? setInterval(() => {
        if (stopped || renewing) return;
        renewing = db.transaction(async () => {
          const time = now();
          const result = await db.prepare("", "UPDATE platform_upload_reservations SET expires_ms=? WHERE id=? AND expires_ms>?").run(time + reservationMs, id, time);
          if (result.changes !== 1) throw new Error("Platform disk reservation expired");
        }).catch(() => console.warn("platform_disk_reservation_renew_failed"))
          .finally(() => { renewing = undefined; });
      }, renewEveryMs)
    : undefined;
  timer?.unref();

  return {
    async grow(additional: number) {
      if (!Number.isSafeInteger(additional) || additional <= 0)
        throw new Error("Некорректное увеличение резерва диска");
      if (stopped) throw new Error("Резерв диска уже освобождён");
      if (db.kind === "postgres")
        await db.transaction(async () => {
          await db.prepare("", "SELECT pg_advisory_xact_lock(?)").get(PLATFORM_DISK_LOCK);
          const time = now();
          const own = await db.prepare("", "SELECT reserved_bytes AS bytes FROM platform_upload_reservations WHERE id=? AND expires_ms>?").get(id, time);
          if (!own) throw new UploadQuotaError("Резерв места истёк. Повторите импорт.", 507);
          const pending = Number((await db.prepare("", "SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM platform_upload_reservations").get())?.bytes || 0);
          await check(additional, pending);
          await db.prepare("", "UPDATE platform_upload_reservations SET reserved_bytes=reserved_bytes+?,expires_ms=? WHERE id=?").run(additional, time + reservationMs, id);
        });
      else await check(additional, 0);
    },
    async assertValid() {
      await renewing;
      if (stopped) throw new UploadQuotaError("Резерв места истёк. Повторите импорт.", 507);
      if (db.kind === "postgres" && !(await db.prepare("", "SELECT 1 AS valid FROM platform_upload_reservations WHERE id=? AND expires_ms>?").get(id, now())))
        throw new UploadQuotaError("Резерв места истёк. Повторите импорт.", 507);
    },
    async release() {
      stopped = true;
      if (timer) clearInterval(timer);
      await renewing;
      if (db.kind === "postgres")
        await db.prepare("", "DELETE FROM platform_upload_reservations WHERE id=?").run(id);
    },
  };
}
