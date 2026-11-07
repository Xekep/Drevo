import { archiveFetch } from "../../data/archive-fetch.ts";
import { generationReport, type GenerationNumbering } from "../../domain/generation-report.ts";
import type { Family } from "../../domain/types.ts";

/** Fetch full permitted cards once; shared links use their own access boundary. */
export async function downloadGenerationReport(
  rootId: string,
  signal: AbortSignal,
  sourceUrl = "/api/family",
  numbering: GenerationNumbering = "daboville",
) {
  if (!rootId)
    throw new Error("Выберите родоначальника для росписи.");
  const response = await archiveFetch(sourceUrl, { signal, cache: "no-store" });
  if (!response.ok)
    throw new Error(
      "Не удалось получить данные для росписи. Проверьте доступ к древу.",
    );
  const data = (await response.json()) as {
    family: Family;
    readTree?: boolean;
  };
  signal.throwIfAborted();
  if (data.readTree === false || !data.family?.people)
    throw new Error("Нет доступа к данным древа.");
  const known = new Set(data.family.people.map((person) => person.id));
  if (!known.has(rootId))
    throw new Error(
      "Состав или доступ к древу изменился. Обновите древо и повторите экспорт.",
    );
  const content = generationReport(data.family, known, rootId, numbering);
  signal.throwIfAborted();
  const url = URL.createObjectURL(
    new Blob(["\uFEFF", content], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  const title = data.family.title
    .replace(/\p{Cc}|[<>:"/\\|?*]/gu, "_")
    .trim()
    .slice(0, 100);
  link.download = `Поколенная роспись${title ? ` — ${title}` : ""}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
