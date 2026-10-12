import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { StoreDatabase } from "./store-database.ts";
import { originalMediaPattern } from "./media.ts";
import { recordMediaOriginal } from "./media-originals.ts";
import { postgresMediaReferencesSql } from "./media-reference-sql.ts";
import type { WorkQueue } from "./work-queue.ts";

const sqliteReferences = `SELECT json_extract(data,'$.photo') AS url FROM people
  UNION ALL SELECT json_extract(data,'$.url') FROM photos
  UNION ALL SELECT j.value FROM people p,json_tree(p.data) j WHERE j.key='url' AND j.type='text'
  UNION ALL SELECT j.value FROM family_unions u,json_tree(u.data) j WHERE j.key='url' AND j.type='text'
  UNION ALL SELECT j.value FROM relations r,json_tree(r.sources) j WHERE j.key='url' AND j.type='text'`;
type Usage = { files: number; bytes: number };
export type MediaUsageLedger = ReturnType<typeof mediaUsageLedger>;

/** SQL owns current usage. Disk reconciliation never holds SQL/advisory locks.
 * A private archive indexes only its references, never somebody else's files.
 */
export function mediaUsageLedger(
  db: StoreDatabase,
  directory: string,
  {
    discoverUnreferenced = false,
    periodMs = 5 * 60_000,
    now = Date.now,
    executionQueue,
  }: {
    discoverUnreferenced?: boolean;
    periodMs?: number;
    now?: () => number;
    executionQueue?: WorkQueue;
  } = {},
) {
  let initialized = false;
  let closed = false;
  let running: Promise<Usage> | undefined;
  const controller = new AbortController();
  const references = async () =>
    new Set(
      (await db.prepare(sqliteReferences, postgresMediaReferencesSql).all())
        .map((row) => String(row.url ?? "").split(/[?#]/, 1)[0])
        .filter((url) => originalMediaPattern.test(url)),
    );
  const read = async (): Promise<Usage> => {
    const statement = db.prepare(
      `SELECT u.files-(SELECT count(*) FROM documents d JOIN media_originals m ON m.url='/media/'||d.file_name) AS files,
        u.bytes-coalesce((SELECT sum(m.size_bytes) FROM documents d JOIN media_originals m ON m.url='/media/'||d.file_name),0) AS bytes
        FROM media_storage_usage u WHERE id=1`,
      `SELECT u.files-(SELECT count(*) FROM documents d JOIN media_originals m ON m.archive_id=d.archive_id AND m.url='/media/'||d.file_name) AS files,
        u.bytes-coalesce((SELECT sum(m.size_bytes) FROM documents d JOIN media_originals m ON m.archive_id=d.archive_id AND m.url='/media/'||d.file_name),0) AS bytes
        FROM archive_media_storage_usage u WHERE u.archive_id=current_setting('drevo.archive_id')`,
    );
    let row = await statement.get();
    if (!row && db.kind === "postgres") {
      await db
        .prepare(
          "",
          "SELECT drevo_media_usage_initialize(current_setting('drevo.archive_id'))",
        )
        .get();
      row = await statement.get();
    }
    if (!row) throw new Error("Счётчик оригиналов недоступен");
    const files = Number(row.files),
      bytes = Number(row.bytes);
    if (
      !Number.isSafeInteger(files) ||
      !Number.isSafeInteger(bytes) ||
      files < 0 ||
      bytes < 0
    )
      throw new Error("Некорректный счётчик оригиналов");
    return { files, bytes };
  };
  const scan = async () => {
    const scanStarted = now();
    const known = await db
      .prepare(
        "SELECT url,size_bytes,created_at FROM media_originals",
        "SELECT url,size_bytes,created_at FROM media_originals",
      )
      .all();
    const knownUrls = new Set(known.map((row) => String(row.url)));
    const referenced = initialized ? new Set<string>() : await references();
    const documents = new Set(
      (
        await db
          .prepare(
            "SELECT file_name FROM documents",
            "SELECT file_name FROM documents",
          )
          .all()
      ).map((row) => `/media/${String(row.file_name)}`),
    );
    const urls = new Set([...knownUrls, ...referenced]);
    if (discoverUnreferenced) {
      for (const name of await readdir(directory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      ))
        if (originalMediaPattern.test(`/media/${name}`))
          urls.add(`/media/${name}`);
    }
    const found = new Map<string, number>();
    const missing = new Set<string>();
    const iterator = urls.values();
    await Promise.all(
      Array.from({ length: Math.min(16, urls.size) }, async () => {
        for (const url of iterator) {
          if (closed) return;
          if (!originalMediaPattern.test(url) || documents.has(url)) continue;
          const file = await lstat(
            join(directory, url.slice("/media/".length)),
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (
            !file?.isFile() ||
            !Number.isSafeInteger(file.size) ||
            file.size <= 0
          ) {
            missing.add(url);
            continue;
          }
          // Unattached new uploads are registered by their writer with provenance.
          if (
            !referenced.has(url) &&
            !knownUrls.has(url) &&
            file.ctimeMs > scanStarted - 10 * 60_000
          )
            continue;
          found.set(url, file.size);
        }
      }),
    );
    if (closed) throw new Error("Учёт файлов закрыт");
    const additions = [...found].filter(([url]) => !knownUrls.has(url));
    const changes = known.filter(
      (row) =>
        missing.has(String(row.url)) ||
        (found.has(String(row.url)) &&
          found.get(String(row.url)) !== Number(row.size_bytes)),
    );
    // Publish only changed metadata in bounded transactions, rather than issuing
    // one SQL upsert per unchanged original under the archive writer lock.
    for (
      let offset = 0;
      offset < Math.max(additions.length, changes.length);
      offset += 200
    ) {
      if (closed) throw new Error("Учёт файлов закрыт");
      const batch = changes.slice(offset, offset + 200);
      await db.transaction(async () => {
        const hasMissing = batch.some((row) => missing.has(String(row.url)));
        const live = hasMissing ? await references() : new Set<string>();
        const grants = hasMissing
          ? new Set(
              (
                await db
                  .prepare(
                    "SELECT url FROM media_upload_grants WHERE expires_ms>?",
                    "SELECT url FROM media_upload_grants WHERE expires_ms>?",
                  )
                  .all(now())
              ).map((row) => String(row.url)),
            )
          : new Set<string>();
        for (const [url, size] of additions.slice(offset, offset + 200))
          await recordMediaOriginal(db, url, size, null);
        for (const row of batch) {
          const url = String(row.url),
            created = String(row.created_at);
          if (Date.parse(created) > scanStarted) continue;
          const size = found.get(url);
          if (size !== undefined && size !== Number(row.size_bytes)) {
            await db
              .prepare(
                "UPDATE media_originals SET size_bytes=? WHERE url=? AND size_bytes=? AND created_at=?",
                "UPDATE media_originals SET size_bytes=? WHERE url=? AND size_bytes=? AND created_at=?",
              )
              .run(size, url, Number(row.size_bytes), created);
          } else if (missing.has(url) && !live.has(url) && !grants.has(url)) {
            await db
              .prepare(
                "DELETE FROM media_originals WHERE url=? AND size_bytes=? AND created_at=?",
                "DELETE FROM media_originals WHERE url=? AND size_bytes=? AND created_at=?",
              )
              .run(url, Number(row.size_bytes), created);
          }
        }
      });
    }
    initialized = true;
    if (missing.size)
      console.warn(
        JSON.stringify({
          event: "media_references_missing",
          count: missing.size,
        }),
      );
    return read();
  };
  const reconcile = () => {
    if (closed) return Promise.reject(new Error("Учёт файлов закрыт"));
    return (running ??= (async () => {
      const release = await executionQueue?.acquire(controller.signal);
      try {
        controller.signal.throwIfAborted();
        return await scan();
      } finally {
        release?.();
      }
    })().finally(() => {
      running = undefined;
    }));
  };
  const timer = periodMs
    ? setInterval(() => {
        void reconcile().catch(() =>
          console.warn("media_usage_reconcile_failed"),
        );
      }, periodMs)
    : undefined;
  timer?.unref();
  return {
    read,
    reconcile,
    async ensure() {
      if (!initialized) await reconcile();
    },
    async close() {
      closed = true;
      controller.abort();
      if (timer) clearInterval(timer);
      await running?.catch(() => undefined);
    },
  };
}
