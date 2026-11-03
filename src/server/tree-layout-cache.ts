import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  readdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type { LayoutCacheInput } from "../domain/layout-cache-key.ts";
import type { TreeGeometry } from "../domain/tree-layout.ts";
import type { TreeLayoutCalculator } from "./tree-layout-calculator.ts";

const MAX_ENTRY = 2 * 1024 ** 2,
  MAX_TOTAL = 16 * 1024 ** 2,
  MAX_AGE = 14 * 86400_000;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Archive-owned derived files. Only the server calculator can publish geometry. */
export function sharedTreeLayoutCache(
  root: string,
  calculator: Pick<TreeLayoutCalculator, "calculate">,
) {
  const directory = join(root, ".tree-layout-cache");
  const closing = new AbortController(),
    pending = new Map<string, Promise<void>>();
  const prune = async () => {
    const files = await Promise.all(
      (await readdir(directory))
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map(async (name) => {
          const path = join(directory, name),
            info = await stat(path).catch(() => null);
          return info && { path, size: info.size, time: info.mtimeMs };
        }),
    );
    const ordered = files
      .filter((file) => file !== null)
      .sort((a, b) => b.time - a.time);
    let bytes = 0;
    for (const [index, file] of ordered.entries()) {
      bytes += file.size;
      if (index >= 16 || bytes > MAX_TOTAL || Date.now() - file.time > MAX_AGE)
        await unlink(file.path).catch(() => {});
    }
  };
  const warm = async (hash: string, input: LayoutCacheInput) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = join(directory, `${hash}.lock`),
      token = randomUUID();
    const stale = await stat(lockPath).catch(() => null);
    if (stale && Date.now() - stale.mtimeMs > 120_000)
      await unlink(lockPath).catch(() => {});
    const lock = await open(lockPath, "wx", 0o600).catch(() => null);
    if (!lock) return;
    const temporary = join(directory, `${hash}-${token}.tmp`);
    try {
      await lock.writeFile(token);
      await lock.close();
      closing.signal.throwIfAborted();
      const geometry = await calculator.calculate(input, closing.signal);
      closing.signal.throwIfAborted();
      const value = JSON.stringify(geometry),
        body = JSON.stringify({ hash, value, checksum: digest(value) });
      if (Buffer.byteLength(body) > MAX_ENTRY) return;
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(body);
      } finally {
        await file.close();
      }
      await rename(temporary, join(directory, `${hash}.json`));
      await prune();
    } finally {
      await lock.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      if ((await readFile(lockPath, "utf8").catch(() => "")) === token)
        await unlink(lockPath).catch(() => {});
    }
  };
  return {
    async readOrWarm(
      hash: string,
      input: LayoutCacheInput,
    ): Promise<TreeGeometry | null> {
      if (!/^[a-f0-9]{64}$/.test(hash) || closing.signal.aborted) return null;
      try {
        const path = join(directory, `${hash}.json`),
          info = await stat(path);
        if (info.size <= MAX_ENTRY && Date.now() - info.mtimeMs <= MAX_AGE) {
          const entry = JSON.parse(await readFile(path, "utf8"));
          if (
            entry.hash === hash &&
            typeof entry.value === "string" &&
            digest(entry.value) === entry.checksum
          )
            return JSON.parse(entry.value) as TreeGeometry;
        }
      } catch {
        /* Optional cache: a miss or corrupt file falls back to local layout. */
      }
      if (!pending.has(hash) && pending.size < 3) {
        const task = warm(hash, input)
          .catch(() => {})
          .finally(() => pending.delete(hash));
        pending.set(hash, task);
      }
      return null;
    },
    async close() {
      closing.abort();
      await Promise.allSettled([...pending.values()]);
    },
  };
}
export type SharedTreeLayoutCache = ReturnType<typeof sharedTreeLayoutCache>;
