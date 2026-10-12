import type { IncomingMessage, ServerResponse } from "node:http";
import { workQueue, WorkQueueBusyError } from "./work-queue.ts";
import { memberPreviewAt } from "../domain/archive-context.ts";

export type RoutedArchive = {
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ) => Promise<void>;
  close: () => Promise<void>;
  poolDiagnostics?: () => {
    total: number;
    idle: number;
    waiting: number;
    limit: number;
  } | null;
};

type Entry = {
  runtime: RoutedArchive;
  active: number;
  usedAt: number;
  idleSince: number;
};
const MAX_OPEN_ARCHIVES = 128;
const WAIT_FOR_IDLE_MS = 5000;
const MAX_QUEUED_OPENS = 256;
class ArchivePoolBusyError extends WorkQueueBusyError {}

/** Keep explicitly selected archive runtimes bounded and never evict an active one. */
export function archiveRoutePool(
  permitted: (
    req: IncomingMessage,
    archiveId: string,
    path: string,
  ) => Promise<boolean>,
  open: (archiveId: string) => Promise<RoutedArchive>,
  options: {
    maxOpen?: number;
    idleMs?: number;
    startupConcurrency?: number;
    startupWaitMs?: number;
  } = {},
) {
  const maxOpen = options.maxOpen ?? 4;
  if (!Number.isInteger(maxOpen) || maxOpen < 1 || maxOpen > MAX_OPEN_ARCHIVES)
    throw new Error("Invalid archive runtime limit");
  const startupConcurrency = options.startupConcurrency ?? 4;
  const startupWaitMs = options.startupWaitMs ?? 30_000;
  if (
    !Number.isInteger(startupConcurrency) ||
    startupConcurrency < 1 ||
    startupConcurrency > 8 ||
    !Number.isInteger(startupWaitMs) ||
    startupWaitMs < 1 ||
    startupWaitMs > 60_000
  )
    throw new Error("Invalid archive startup limits");
  const starts = workQueue(startupConcurrency, MAX_QUEUED_OPENS, startupWaitMs);
  const entries = new Map<string, Entry>();
  type Waiting = {
    req: IncomingMessage;
    res: ServerResponse;
    path: string;
    pinned: boolean;
  };
  type Opening = {
    value: Promise<Entry | null>;
    waiters: Set<Waiting>;
    entry?: Entry;
    controller: AbortController;
    started: boolean;
  };
  const opening = new Map<string, Opening>();
  const retiring = new Map<Entry, Promise<void>>();
  const idleWaiters = new Set<() => void>();
  let lastUse = 0;
  let reservations = 0;
  let closing = false;
  let closingPromise: Promise<void> | undefined;
  const wake = () => {
    for (const done of [...idleWaiters]) done();
  };
  const releaseEntry = (entry: Entry) => {
    entry.active--;
    if (!entry.active) {
      entry.idleSince = Date.now();
      wake();
    }
  };
  const retire = (id: string, entry: Entry) => {
    const previous = retiring.get(entry);
    if (previous) return previous;
    // Delete and reserve synchronously, including asynchronous resource close.
    entries.delete(id);
    const done = Promise.resolve()
      .then(() => entry.runtime.close())
      .finally(() => {
        retiring.delete(entry);
        wake();
      });
    retiring.set(entry, done);
    return done;
  };
  const reserveCapacity = async () => {
    const deadline = Date.now() + WAIT_FOR_IDLE_MS;
    for (;;) {
      if (closing) throw new ArchivePoolBusyError();
      if (entries.size + reservations + retiring.size < maxOpen) {
        reservations++;
        return;
      }
      const idle = [...entries]
        .filter(([, entry]) => entry.active === 0)
        .sort((left, right) => left[1].usedAt - right[1].usedAt)[0];
      if (idle) {
        await retire(idle[0], idle[1]);
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ArchivePoolBusyError();
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          idleWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        idleWaiters.add(done);
      });
    }
  };
  const permittedWaiter = async (pending: Opening, id: string) => {
    for (const waiter of pending.waiters)
      if (
        !waiter.res.destroyed &&
        (await permitted(waiter.req, id, waiter.path))
      )
        return true;
    return false;
  };
  const createOpening = (id: string) => {
    const pending: Opening = {
      value: Promise.resolve(null),
      waiters: new Set(),
      controller: new AbortController(),
      started: false,
    };
    // A singleflight belongs to an archive, not its first caller's grant. A
    // revoked first caller cannot deny another still-authorized waiting caller.
    pending.value = Promise.resolve()
      .then(async () => {
        const releaseStart = await starts.acquire(pending.controller.signal);
        pending.started = true;
        let reserved = false;
        try {
          if (pending.controller.signal.aborted) return null;
          const beforeCapacity = await permittedWaiter(pending, id);
          if (closing) throw new ArchivePoolBusyError();
          if (!beforeCapacity) return null;
          await reserveCapacity();
          reserved = true;
          const beforeStartup = await permittedWaiter(pending, id);
          if (closing) throw new ArchivePoolBusyError();
          if (!beforeStartup) return null;
          const runtime = await open(id);
          let publish = false;
          try {
            publish = await permittedWaiter(pending, id);
            publish = publish && !closing;
          } catch (error) {
            await runtime.close();
            throw error;
          }
          if (!publish) {
            await runtime.close();
            if (closing) throw new ArchivePoolBusyError();
            return null;
          }
          const entry: Entry = {
            runtime,
            // Pin every waiter before publishing. Their independent final grant
            // checks may await SQL, during which eviction must not close the view.
            active: pending.waiters.size,
            usedAt: ++lastUse,
            idleSince: Date.now(),
          };
          pending.entry = entry;
          for (const waiter of pending.waiters) waiter.pinned = true;
          entries.set(id, entry);
          return entry;
        } finally {
          if (reserved) {
            reservations--;
            wake();
          }
          releaseStart();
        }
      })
      .finally(() => {
        if (opening.get(id) === pending) opening.delete(id);
      });
    opening.set(id, pending);
    return pending;
  };
  const acquire = async (
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    path: string,
  ) => {
    if (closing) throw new ArchivePoolBusyError();
    if (!(await permitted(req, id, path))) return null;
    if (closing) throw new ArchivePoolBusyError();
    const present = entries.get(id);
    if (present) {
      present.active++;
      present.usedAt = ++lastUse;
      return present;
    }
    if (
      !opening.has(id) &&
      opening.size >= MAX_QUEUED_OPENS + startupConcurrency
    )
      throw new ArchivePoolBusyError();
    const pending = opening.get(id) ?? createOpening(id);
    const waiter = { req, res, path, pinned: false };
    pending.waiters.add(waiter);
    const disconnected = () => {
      pending.waiters.delete(waiter);
      if (waiter.pinned && pending.entry) {
        waiter.pinned = false;
        releaseEntry(pending.entry);
      }
      if (!pending.started && !pending.waiters.size) {
        if (opening.get(id) === pending) opening.delete(id);
        pending.controller.abort();
      }
    };
    res.once("close", disconnected);
    let entry: Entry | null = null,
      accepted = false;
    try {
      entry = await pending.value;
      if (closing) throw new ArchivePoolBusyError();
      if (!entry || res.destroyed) return null;
      const stillPermitted = await permitted(req, id, path);
      if (closing) throw new ArchivePoolBusyError();
      if (!stillPermitted || res.destroyed) return null;
      accepted = true;
      waiter.pinned = false; // Reservation now belongs to the handler.
      entry.usedAt = ++lastUse;
      return entry;
    } finally {
      pending.waiters.delete(waiter);
      res.off("close", disconnected);
      if (entry && !accepted && waiter.pinned) releaseEntry(entry);
    }
  };
  const idleMs = options.idleMs ?? (maxOpen > 4 ? 5 * 60_000 : 0);
  const cleanup =
    idleMs > 0
      ? setInterval(
          () => {
            if (closing) return;
            void (async () => {
              for (const [id, entry] of entries) {
                if (entry.active || Date.now() - entry.idleSince < idleMs)
                  continue;
                await retire(id, entry);
              }
            })().catch(() => console.warn("archive_idle_cleanup_failed"));
          },
          Math.min(idleMs || 60_000, 60_000),
        )
      : null;
  cleanup?.unref();
  return {
    diagnostics: () => ({
      open: entries.size,
      active: [...entries.values()].reduce(
        (sum, entry) => sum + entry.active,
        0,
      ),
      queued: starts.diagnostics().queued,
      opening: reservations,
      startup: starts.diagnostics(),
      pools: [...entries.values()].flatMap((entry) => {
        const pool = entry.runtime.poolDiagnostics?.();
        return pool ? [pool] : [];
      }),
    }),
    async route(req: IncomingMessage, res: ServerResponse, url: URL) {
      const direct =
        /^\/a\/([A-Za-z0-9][A-Za-z0-9-]{2,63})(\/(?:api|media)\/.*)$/.exec(
          url.pathname,
        );
      const preview = memberPreviewAt(url.pathname);
      const match =
        direct ||
        (preview?.archiveId && /^\/(?:api|media)\/.*$/.test(preview.innerPath)
          ? [
              url.pathname,
              preview.archiveId,
              `${preview.prefix.slice(`/a/${preview.archiveId}`.length)}${preview.innerPath}`,
            ]
          : null);
      if (!match) return false;
      let entry: Entry | null;
      try {
        entry = await acquire(req, res, match[1], match[2]);
      } catch (error) {
        if (res.destroyed) return true;
        if (!(error instanceof WorkQueueBusyError)) throw error;
        res.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "2",
        });
        res.end(JSON.stringify({ error: "Сервер занят. Попробуйте ещё раз." }));
        return true;
      }
      if (res.destroyed) {
        if (entry) releaseEntry(entry);
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
      let handlerDone = false;
      let responseDone = res.writableEnded || res.destroyed;
      const release = () => {
        if (released || !handlerDone || !responseDone) return;
        released = true;
        releaseEntry(entry);
      };
      res.once("close", () => {
        responseDone = true;
        release();
      });
      try {
        await entry.runtime.handle(req, res, match[2] + url.search);
      } finally {
        handlerDone = true;
        responseDone ||= res.writableEnded || res.destroyed;
        release();
      }
      return true;
    },
    close() {
      if (closingPromise) return closingPromise;
      closing = true;
      if (cleanup) clearInterval(cleanup);
      starts.close();
      wake();
      closingPromise = (async () => {
        await Promise.allSettled(
          [...opening.values()].map((pending) => pending.value),
        );
        const results = await Promise.allSettled([
          ...retiring.values(),
          ...[...entries].map(([id, entry]) => retire(id, entry)),
        ]);
        entries.clear();
        const errors = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length)
          throw new AggregateError(errors, "Archive runtime close failed");
      })();
      return closingPromise;
    },
  };
}
