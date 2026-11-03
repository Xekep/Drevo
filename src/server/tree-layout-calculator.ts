import { Worker } from "node:worker_threads";
import type { TreeGeometry } from "../domain/tree-layout.ts";
import type { LayoutCacheInput } from "../domain/layout-cache-key.ts";
import { workQueue } from "./work-queue.ts";

/** Shared by archive runtimes: at most one CPU worker and two waiting jobs per process. */
export function treeLayoutCalculator() {
  const queue = workQueue(1, 2, 5000);
  const closing = new AbortController();
  const running = new Set<Promise<TreeGeometry>>();
  const calculate = (input: LayoutCacheInput, signal: AbortSignal) => {
    const stop = AbortSignal.any([
      signal,
      closing.signal,
      AbortSignal.timeout(45_000),
    ]);
    const task = (async () => {
      const release = await queue.acquire(stop);
      let worker: Worker | undefined;
      try {
        stop.throwIfAborted();
        worker = new Worker(
          new URL("./tree-layout-worker.ts", import.meta.url),
          {
            workerData: input,
            resourceLimits: { maxOldGenerationSizeMb: 256 },
          },
        );
        return await new Promise<TreeGeometry>((resolve, reject) => {
          const abort = () => reject(stop.reason);
          stop.addEventListener("abort", abort, { once: true });
          const cleanup = () => stop.removeEventListener("abort", abort);
          worker!.once("message", (geometry) => {
            cleanup();
            resolve(geometry);
          });
          worker!.once("error", (error) => {
            cleanup();
            reject(error);
          });
          worker!.once("exit", () => {
            cleanup();
            reject(new Error("Расчёт раскладки остановлен"));
          });
        });
      } finally {
        await worker?.terminate();
        release();
      }
    })();
    running.add(task);
    void task.finally(() => running.delete(task)).catch(() => {});
    return task;
  };
  return {
    calculate,
    async close() {
      closing.abort();
      queue.close();
      await Promise.allSettled([...running]);
    },
  };
}
export type TreeLayoutCalculator = ReturnType<typeof treeLayoutCalculator>;
