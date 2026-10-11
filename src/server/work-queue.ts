export class WorkQueueBusyError extends Error {
  constructor() {
    super("Сервер занят. Повторите запрос немного позже.");
  }
}

/** Bounded FIFO. Waiting jobs own no worker/DB slot; cancellation removes them. */
export function workQueue(
  concurrency: number,
  maximumWaiting: number,
  waitMs = 45_000,
) {
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isInteger(maximumWaiting) ||
    maximumWaiting < 0
  )
    throw new Error("Invalid work queue limits");
  let active = 0,
    closing = false;
  const waiting: Array<{ grant: () => void; reject: () => void }> = [];
  const releaseSlot = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next.grant();
      else active--;
    };
  };
  return {
    async acquire(signal?: AbortSignal): Promise<() => void> {
      signal?.throwIfAborted();
      if (closing) throw new WorkQueueBusyError();
      if (active < concurrency) {
        active++;
        return releaseSlot();
      }
      if (waiting.length >= maximumWaiting) throw new WorkQueueBusyError();
      return await new Promise((resolve, reject) => {
        const remove = (error: Error) => {
          const index = waiting.indexOf(job);
          if (index < 0) return;
          waiting.splice(index, 1);
          cleanup();
          reject(error);
        };
        const abort = () =>
          remove(new DOMException("Работа остановлена", "AbortError"));
        const timer = setTimeout(
          () => remove(new WorkQueueBusyError()),
          waitMs,
        );
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        const job = {
          grant: () => {
            cleanup();
            resolve(releaseSlot());
          },
          reject: () => remove(new WorkQueueBusyError()),
        };
        signal?.addEventListener("abort", abort, { once: true });
        waiting.push(job);
      });
    },
    diagnostics: () => ({
      active,
      queued: waiting.length,
      concurrency,
      maximumWaiting,
    }),
    close() {
      closing = true;
      for (const job of [...waiting]) job.reject();
    },
  };
}
export type WorkQueue = ReturnType<typeof workQueue>;
