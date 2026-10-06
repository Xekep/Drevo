import { decodePdfPages } from "./document-pdf-decoder.ts";
import type { PdfPageSize } from "./document-pdf.ts";

export class PdfDecodeBusyError extends Error {
  constructor() {
    super("Сервер готовит другие документы. Повторите запрос.");
  }
}

type Job = {
  path: string;
  signal: AbortSignal;
  resolve: (pages: PdfPageSize[]) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

/** Root owns one decoder across its archive runtimes, without a global service registry. */
export function pdfDecodeCoordinator(decoder = decodePdfPages, waitMs = 5000) {
  const controller = new AbortController();
  const queue: Job[] = [];
  let active: Promise<void> | undefined;
  const pump = () => {
    if (active || controller.signal.aborted) return;
    const job = queue.shift();
    if (!job) return;
    job.cleanup();
    active = decoder(job.path, AbortSignal.any([job.signal, controller.signal]))
      .then(job.resolve, job.reject)
      .finally(() => {
        active = undefined;
        pump();
      });
  };
  return {
    decode(path: string, signal: AbortSignal) {
      if (controller.signal.aborted || signal.aborted)
        return Promise.reject<PdfPageSize[]>(
          new Error("Подготовка PDF отменена"),
        );
      if (queue.length >= 8)
        return Promise.reject<PdfPageSize[]>(new PdfDecodeBusyError());
      return new Promise<PdfPageSize[]>((resolve, reject) => {
        const remove = (error: Error) => {
          const index = queue.indexOf(job);
          if (index < 0) return;
          queue.splice(index, 1);
          job.cleanup();
          reject(error);
        };
        const abort = () => remove(new Error("Подготовка PDF отменена"));
        const timer = setTimeout(
          () => remove(new PdfDecodeBusyError()),
          waitMs,
        );
        const job: Job = {
          path,
          signal,
          resolve,
          reject,
          cleanup: () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
          },
        };
        signal.addEventListener("abort", abort, { once: true });
        queue.push(job);
        pump();
      });
    },
    diagnostics: () => ({ active: Number(!!active), queued: queue.length }),
    async close() {
      controller.abort();
      for (const job of queue.splice(0)) {
        job.cleanup();
        job.reject(new Error("Подготовка PDF отменена"));
      }
      await active;
    },
  };
}
