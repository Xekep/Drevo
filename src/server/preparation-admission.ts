import type { IncomingMessage, ServerResponse } from "node:http";
import { WorkQueueBusyError } from "./work-queue.ts";

export const PREPARATION_BYTES = {
  ai: 64 * 1024 ** 2,
  image: 96 * 1024 ** 2,
  discussion: 96 * 1024 ** 2,
  export: 64 * 1024 ** 2,
} as const;

/** A process-owned budget: acquire before buffers, decoders or full snapshots. */
export function preparationAdmission({
  concurrent = 2,
  bytes = 96 * 1024 ** 2,
  maximumWaiting = 32,
  waitMs = 5_000,
} = {}) {
  if (
    !Number.isSafeInteger(concurrent) ||
    concurrent < 1 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    !Number.isSafeInteger(maximumWaiting) ||
    maximumWaiting < 0 ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < 1
  )
    throw new Error("Некорректный бюджет подготовки запросов");
  let closing = false,
    active = 0,
    reservedBytes = 0;
  const waiting: Array<{
    weight: number;
    grant: () => void;
    reject: () => void;
  }> = [];
  const idleWaiters = new Set<() => void>();
  const notifyIdle = () => {
    if (active || waiting.length) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  const lease = (weight: number) => {
    active++;
    reservedBytes += weight;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      reservedBytes -= weight;
      pump();
      notifyIdle();
    };
  };
  const pump = () => {
    while (
      !closing &&
      active < concurrent &&
      waiting.length &&
      reservedBytes + waiting[0].weight <= bytes
    )
      waiting.shift()!.grant();
  };
  return {
    async acquire(weight: number, signal?: AbortSignal): Promise<() => void> {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(weight) || weight < 1 || weight > bytes)
        throw new WorkQueueBusyError();
      if (closing) throw new WorkQueueBusyError();
      if (
        !waiting.length &&
        active < concurrent &&
        reservedBytes + weight <= bytes
      )
        return lease(weight);
      if (waiting.length >= maximumWaiting) throw new WorkQueueBusyError();
      return await new Promise((resolve, reject) => {
        const remove = (error: Error) => {
          const index = waiting.indexOf(job);
          if (index < 0) return;
          waiting.splice(index, 1);
          cleanup();
          reject(error);
          pump();
          notifyIdle();
        };
        const abort = () =>
          remove(new DOMException("Подготовка отменена", "AbortError"));
        const timer = setTimeout(
          () => remove(new WorkQueueBusyError()),
          waitMs,
        );
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        const job = {
          weight,
          grant: () => {
            cleanup();
            resolve(lease(weight));
          },
          reject: () => remove(new WorkQueueBusyError()),
        };
        signal?.addEventListener("abort", abort, { once: true });
        waiting.push(job);
      });
    },
    diagnostics: () => ({
      active,
      reservedBytes,
      concurrent,
      maximumBytes: bytes,
      queued: waiting.length,
      maximumWaiting,
    }),
    close() {
      closing = true;
      for (const job of [...waiting]) job.reject();
      notifyIdle();
    },
    /** Call close first at process shutdown; leases finish cleanup while DBs live. */
    drain() {
      if (!active && !waiting.length) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
  };
}

export type PreparationAdmission = ReturnType<typeof preparationAdmission>;

/** Cancel one waiter without aborting a shared cache/reconciliation operation. */
export async function waitForPreparation<T>(
  work: Promise<T>,
  signal?: AbortSignal,
) {
  if (signal?.aborted) void work.catch(() => {});
  signal?.throwIfAborted();
  if (!signal) return await work;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () =>
          reject(
            signal.reason ??
              new DOMException("Подготовка отменена", "AbortError"),
          );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Persisted AI turns retain only small request metadata while awaiting a provider. */
export function pendingAiAdmission() {
  return preparationAdmission({
    concurrent: 32,
    bytes: 96 * 1024 ** 2,
    maximumWaiting: 0,
    waitMs: 1,
  });
}

/** Disconnect cancels preparation, but does not cancel a committed AI turn. */
export function preparationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deadlineMs = 120_000,
) {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    if (!req.complete && !req.destroyed) req.destroy();
  };
  const deadline = setTimeout(abort, deadlineMs);
  deadline.unref();
  req.once("aborted", abort);
  res.once("close", abort);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(deadline);
      req.off("aborted", abort);
      res.off("close", abort);
    },
  };
}

export async function withPreparation<T>(
  req: IncomingMessage,
  res: ServerResponse,
  budget: PreparationAdmission,
  weight: number,
  work: (signal: AbortSignal) => Promise<T>,
) {
  const request = preparationRequest(req, res);
  let release: (() => void) | undefined;
  try {
    release = await budget.acquire(weight, request.signal);
    request.signal.throwIfAborted();
    return await work(request.signal);
  } catch (error) {
    if (error instanceof WorkQueueBusyError && !res.headersSent)
      res.setHeader("Retry-After", "2");
    throw error;
  } finally {
    release?.();
    request.dispose();
  }
}
