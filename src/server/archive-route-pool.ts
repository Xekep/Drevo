import type { IncomingMessage, ServerResponse } from "node:http";

export type RoutedArchive = {
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ) => Promise<void>;
  close: () => Promise<void>;
};

type Entry = { runtime: RoutedArchive; active: number; usedAt: number };
const MAX_OPEN_ARCHIVES = 4;
class ArchivePoolBusyError extends Error {}

/** Keep explicitly selected archive runtimes bounded and never evict an active one. */
export function archiveRoutePool(
  permitted: (req: IncomingMessage, archiveId: string) => Promise<boolean>,
  open: (archiveId: string) => Promise<RoutedArchive>,
) {
  const entries = new Map<string, Entry>();
  const opening = new Map<string, Promise<Entry | null>>();
  let lastUse = 0;
  let queue = Promise.resolve();
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
  const get = async (req: IncomingMessage, id: string) => {
    const present = entries.get(id);
    if (present) return present;
    let pending = opening.get(id);
    if (!pending) {
      pending = exclusive(async () => {
        const existing = entries.get(id);
        if (existing) return existing;
        if (!(await permitted(req, id))) return null;
        if (entries.size >= MAX_OPEN_ARCHIVES) {
          const idle = [...entries]
            .filter(([, entry]) => entry.active === 0)
            .sort((left, right) => left[1].usedAt - right[1].usedAt)[0];
          if (!idle) throw new ArchivePoolBusyError();
          entries.delete(idle[0]);
          await idle[1].runtime.close();
        }
        const entry: Entry = {
          runtime: await open(id),
          active: 0,
          usedAt: ++lastUse,
        };
        entries.set(id, entry);
        return entry;
      });
      opening.set(id, pending);
      void pending.finally(() => opening.delete(id)).catch(() => {});
    }
    return await pending;
  };
  return {
    async route(req: IncomingMessage, res: ServerResponse, url: URL) {
      const match =
        /^\/a\/([A-Za-z0-9][A-Za-z0-9-]{2,63})(\/(?:api|media)\/.*)$/.exec(
          url.pathname,
        );
      if (!match) return false;
      let entry: Entry | null;
      try {
        entry = await get(req, match[1]);
      } catch (error) {
        if (!(error instanceof ArchivePoolBusyError)) throw error;
        res.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "2",
        });
        res.end(JSON.stringify({ error: "Сервер занят. Попробуйте ещё раз." }));
        return true;
      }
      if (!entry) {
        res.writeHead(404, { "Cache-Control": "no-store" });
        res.end();
        return true;
      }
      entry.active++;
      entry.usedAt = ++lastUse;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        entry.active--;
      };
      res.once("close", release);
      try {
        await entry.runtime.handle(req, res, match[2] + url.search);
      } finally {
        if (res.writableEnded || res.destroyed) release();
      }
      return true;
    },
    async close() {
      await queue;
      await Promise.all(
        [...entries.values()].map((entry) => entry.runtime.close()),
      );
      entries.clear();
    },
  };
}
