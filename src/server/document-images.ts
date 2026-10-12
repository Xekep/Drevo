import sharp from "sharp";
import { imageExtension } from "./media.ts";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { MAX_TIFF_BYTES } from "../shared/upload-limits.ts";
import { readPreparedFile } from "./prepared-file.ts";
import { workQueue, WorkQueueBusyError } from "./work-queue.ts";
import {
  preparationAdmission,
  PREPARATION_BYTES,
  type PreparationAdmission,
} from "./preparation-admission.ts";

export function documentImageExtension(bytes: Buffer) {
  const signature = bytes.subarray(0, 4).toString("hex");
  if (["49492a00", "4d4d002a", "49492b00", "4d4d002b"].includes(signature))
    return "tif";
  return imageExtension(bytes);
}

const inputOptions = { limitInputPixels: 50_000_000 };

export async function tiffDocumentPages(
  input: string | Buffer,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const bytes =
    typeof input === "string"
      ? await readPreparedFile(input, MAX_TIFF_BYTES, signal)
      : input;
  if (bytes.length > MAX_TIFF_BYTES) throw new RangeError("TIFF больше 50 МБ");
  const first = await sharp(bytes, inputOptions)
    .timeout({ seconds: 25 })
    .metadata();
  const count = first.pages ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 2000)
    throw new Error("TIFF должен содержать от 1 до 2000 страниц");
  const pages: { width: number; height: number }[] = [];
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted();
    const metadata =
      index === 0
        ? first
        : await sharp(bytes, { ...inputOptions, page: index })
            .timeout({ seconds: 25 })
            .metadata();
    let { width, height } = metadata;
    if (!width || !height || width * height > inputOptions.limitInputPixels)
      throw new Error("Страница TIFF превышает 50 мегапикселей");
    if ((metadata.orientation ?? 1) >= 5) [width, height] = [height, width];
    pages.push({ width, height });
  }
  return pages;
}

/** Serialize TIFF decoding and share concurrent requests for the same page. */
export function tiffDocumentRenderer(preparation?: PreparationAdmission) {
  type Job = {
    promise: Promise<Buffer>;
    controller: AbortController;
    users: number;
  };
  const pending = new Map<string, Job>();
  const cache = new Map<string, Buffer>();
  let cachedBytes = 0;
  const maximumCachedBytes = 32 * 1024 ** 2;
  const budget = preparation ?? preparationAdmission();
  const queue = workQueue(1, 32, 5_000);
  const controller = new AbortController();
  const retain = async (job: Job, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    job.users++;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        job.promise,
        new Promise<never>((_resolve, reject) => {
          abort = () =>
            reject(new DOMException("Подготовка отменена", "AbortError"));
          signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      job.users--;
      if (!job.users) job.controller.abort();
    }
  };
  const render = async (path: string, page: number, signal?: AbortSignal) => {
    controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    const info = await stat(path);
    signal?.throwIfAborted();
    const key = createHash("sha256")
      .update(`${path}:${info.size}:${info.mtimeMs}:${page}:v1`)
      .digest("hex");
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const existing = pending.get(key);
    if (existing) return await retain(existing, signal);
    if (pending.size >= 32) throw new WorkQueueBusyError();
    const jobController = new AbortController();
    const workSignal = AbortSignal.any([
      jobController.signal,
      controller.signal,
    ]);
    const result = (async () => {
      const releaseQueue = await queue.acquire(workSignal);
      let releaseMemory: (() => void) | undefined;
      try {
        releaseMemory = await budget.acquire(
          PREPARATION_BYTES.image,
          workSignal,
        );
        workSignal.throwIfAborted();
        const original = await readPreparedFile(
          path,
          MAX_TIFF_BYTES,
          workSignal,
        );
        const bytes = await sharp(original, { ...inputOptions, page })
          .timeout({ seconds: 25 })
          .rotate()
          .resize({
            width: 2400,
            height: 2400,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 92 })
          .toBuffer();
        workSignal.throwIfAborted();
        // Bounded process cache: viewing a large TIFF never creates thousands
        // of unmanaged derived files outside the storage quota.
        if (bytes.length <= maximumCachedBytes) {
          cache.set(key, bytes);
          cachedBytes += bytes.length;
          while (cachedBytes > maximumCachedBytes) {
            const oldest = cache.keys().next().value!;
            cachedBytes -= cache.get(oldest)!.length;
            cache.delete(oldest);
          }
        }
        return bytes;
      } finally {
        releaseMemory?.();
        releaseQueue();
      }
    })();
    const job = { promise: result, controller: jobController, users: 0 };
    pending.set(key, job);
    void result.finally(() => pending.delete(key)).catch(() => {});
    return await retain(job, signal);
  };
  return Object.assign(render, {
    diagnostics: () => ({
      pending: pending.size,
      viewers: [...pending.values()].reduce((sum, job) => sum + job.users, 0),
      cachedBytes,
      cachedPages: cache.size,
      queue: queue.diagnostics(),
    }),
    async close() {
      controller.abort();
      queue.close();
      await Promise.allSettled([...pending.values()].map((job) => job.promise));
      cache.clear();
      cachedBytes = 0;
      if (!preparation) budget.close();
    },
  });
}
