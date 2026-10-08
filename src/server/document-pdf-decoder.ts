import { fork } from "node:child_process";
import type { PdfPageSize } from "./document-pdf.ts";

export function decodePdfPages(
  path: string,
  signal: AbortSignal,
  timeoutMs = 25_000,
  worker = new URL("./document-pdf-worker.ts", import.meta.url),
) {
  return new Promise<PdfPageSize[]>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Подготовка PDF отменена"));
      return;
    }
    const env = Object.fromEntries(
      ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "TZ"].flatMap(
        (key) => (process.env[key] ? [[key, process.env[key]!]] : []),
      ),
    );
    const child = fork(worker, [path], {
      env,
      execArgv: ["--experimental-strip-types", "--max-old-space-size=192"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let pages: PdfPageSize[] | undefined;
    let failed = false;
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.on("message", (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "pages" in value &&
        Array.isArray(value.pages)
      )
        pages = value.pages as PdfPageSize[];
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code) => {
      cleanup();
      if (!failed && code === 0 && pages) resolve(pages);
      else
        reject(
          new Error(
            signal.aborted
              ? "Подготовка PDF отменена"
              : failed
                ? "PDF не удалось подготовить за отведённое время"
                : "Не удалось прочитать PDF",
          ),
        );
    });
  });
}
