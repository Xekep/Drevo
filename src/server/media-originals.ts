import { lstat } from "node:fs/promises";
import type { Family } from "../domain/types.ts";
import type { StoreDatabase } from "./store-database.ts";
import type { mediaStore } from "./media.ts";
import { mediaPattern } from "./media.ts";

const insertSqlite =
  "INSERT INTO media_originals(url,size_bytes,uploaded_by,created_at) VALUES(?,?,?,?) ON CONFLICT(url) DO NOTHING";
const insertPostgres =
  "INSERT INTO media_originals(url,size_bytes,uploaded_by,created_at) VALUES(?,?,?,?) ON CONFLICT(archive_id,url) DO NOTHING";

/** Originals are immutable; the first recorded size and provenance win. */
export async function recordMediaOriginal(
  db: StoreDatabase,
  url: string,
  sizeBytes: number,
  uploadedBy: string | null,
) {
  if (
    !mediaPattern.test(url) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0
  )
    throw new Error("Некорректный оригинал изображения");
  return await db
    .prepare(insertSqlite, insertPostgres)
    .run(url, sizeBytes, uploadedBy, new Date().toISOString());
}

/** Backfill only originals referenced by this archive; never claim all files
 * in a shared uploads directory for a newly created private tree.
 */
export async function indexReferencedMediaOriginals(
  db: StoreDatabase,
  family: Family,
  media: ReturnType<typeof mediaStore>,
) {
  const urls = new Set<string>();
  for (const person of family.people) if (person.photo) urls.add(person.photo);
  for (const photo of family.photos || []) urls.add(photo.url);

  const known = new Set(
    (
      await db
        .prepare(
          "SELECT url FROM media_originals",
          "SELECT url FROM media_originals",
        )
        .all()
    ).map((row) => String(row.url)),
  );
  const found: Array<{ url: string; size: number }> = [];
  let missing = 0;
  // Check known files too: a missing original must still be reported at startup.
  // Limit concurrent filesystem calls so large archives do not serialize lstat.
  const iterator = urls.values();
  await Promise.all(
    Array.from({ length: Math.min(16, urls.size) }, async () => {
      for (;;) {
        const next = iterator.next();
        if (next.done) return;
        const url = next.value;
        const source = media.open(url);
        if (!source) continue;
        const file = await lstat(source.path).catch(() => null);
        if (
          !file?.isFile() ||
          !Number.isSafeInteger(file.size) ||
          file.size <= 0
        ) {
          missing++;
          continue;
        }
        if (!known.has(url)) found.push({ url, size: file.size });
      }
    }),
  );
  if (found.length)
    await db.transaction(async () => {
      for (const file of found)
        await recordMediaOriginal(db, file.url, file.size, null);
    });
  return { indexed: found.length, missing };
}
