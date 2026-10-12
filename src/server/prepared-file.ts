import { open } from "node:fs/promises";

/** Read an admitted immutable input without retaining a native decoder's file handle. */
export async function readPreparedFile(
  path: string,
  maximumBytes: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      !Number.isSafeInteger(info.size) ||
      info.size < 1 ||
      info.size > maximumBytes
    )
      throw new RangeError("Файл превышает допустимый размер");
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(info.size);
    for (let position = 0; position < bytes.length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        bytes,
        position,
        Math.min(1024 * 1024, bytes.length - position),
        position,
      );
      if (!bytesRead) throw new Error("Файл изменился во время чтения");
      position += bytesRead;
    }
    signal?.throwIfAborted();
    // A concurrent append must not turn a bounded input into a larger allocation.
    if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead)
      throw new Error("Файл изменился во время чтения");
    return bytes;
  } finally {
    await file.close();
  }
}
