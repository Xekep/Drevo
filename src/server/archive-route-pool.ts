import type { IncomingMessage, ServerResponse } from "node:http";
import { memberPreviewAt } from "../domain/archive-context.ts";

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
const WAIT_FOR_IDLE_MS = 5000;
class ArchivePoolBusyError extends Error {}

/** Keep explicitly selected archive runtimes bounded and never evict an active one. */
export function archiveRoutePool(
  permitted: (
    req: IncomingMessage,
    archiveId: string,
    path: string,
  ) => Promise<boolean>,
  open: (archiveId: string) => Promise<RoutedArchive>,
) {
  const entries = new Map<string, Entry>();
  const idleWaiters = new Set<() => void>();
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
  const acquire = async (req: IncomingMessage, id: string, path: string) => {
    // Authorization must not depend on whether another request warmed this runtime.
    if (!(await permitted(req, id, path))) return null;
    const present = entries.get(id);
    if (present) {
      present.active++;
      present.usedAt = ++lastUse;
      return present;
    }
    return await exclusive(async () => {
      const existing = entries.get(id);
      if (existing) {
        // Another request may have opened this archive while we waited in
        // the pool queue. Do not reuse its earlier access decision.
        if (!(await permitted(req, id, path))) return null;
        existing.active++;
        existing.usedAt = ++lastUse;
        return existing;
      }
      if (entries.size >= MAX_OPEN_ARCHIVES) {
        const oldestIdle = () =>
          [...entries]
            .filter(([, entry]) => entry.active === 0)
            .sort((left, right) => left[1].usedAt - right[1].usedAt)[0];
        if (!oldestIdle())
          await new Promise<void>((resolve) => {
            const wake = () => {
              clearTimeout(timer);
              idleWaiters.delete(wake);
              resolve();
            };
            const timer = setTimeout(wake, WAIT_FOR_IDLE_MS);
            idleWaiters.add(wake);
          });
        if (!(await permitted(req, id, path))) return null;
        const idle = oldestIdle();
        if (!idle) throw new ArchivePoolBusyError();
        entries.delete(idle[0]);
        await idle[1].runtime.close();
      }
      // A queued request may have lost access before opening starts. Opening
      // can also take time, so check again before publishing the runtime.
      if (!(await permitted(req, id, path))) return null;
      const runtime = await open(id);
      let stillPermitted: boolean;
      try {
        stillPermitted = await permitted(req, id, path);
      } catch (error) {
        await runtime.close();
        throw error;
      }
      if (!stillPermitted) {
        await runtime.close();
        return null;
      }
      const entry: Entry = {
        runtime,
        active: 1,
        usedAt: ++lastUse,
      };
      entries.set(id, entry);
      return entry;
    });
  };
  return {
    async route(req: IncomingMessage, res: ServerResponse, url: URL) {
      const direct =
        /^\/a\/([A-Za-z0-9][A-Za-z0-9-]{2,63})(\/(?:api|media)\/.*)$/.exec(url.pathname);
      const preview = memberPreviewAt(url.pathname);
      const match = direct || (preview?.archiveId &&
        /^\/(?:api|media)\/.*$/.test(preview.innerPath)
        ? [url.pathname, preview.archiveId,
          `${preview.prefix.slice(`/a/${preview.archiveId}`.length)}${preview.innerPath}`]
        : null);
      if (!match) return false;
      let entry: Entry | null;
      try {
        entry = await acquire(req, match[1], match[2]);
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
        const publicShare = match[2].startsWith("/api/shared/");
        res.writeHead(publicShare ? 410 : 404, {
          "Cache-Control": "no-store",
          ...(publicShare
            ? { "Content-Type": "application/json; charset=utf-8" }
            : {}),
        });
        res.end(
          publicShare
            ? JSON.stringify({
                error: "Ссылка недействительна или срок её действия истёк.",
              })
            : undefined,
        );
        return true;
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        entry.active--;
        if (entry.active === 0) for (const wake of idleWaiters) wake();
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
