import type { GenealogyExportFormat } from "../../domain/genealogy-transfer";
import { archiveResourceUrl } from "../../domain/archive-context.ts";

/** A form keeps large GEDZIP downloads out of the browser's JavaScript heap. */
export function downloadVisibleGenealogy(
  format: GenealogyExportFormat,
  personIds: string[],
  onError: (message: string) => void,
) {
  if (!personIds.length) throw new Error("В видимом древе нет людей для экспорта.");
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.name = `drevo-export-${crypto.randomUUID()}`;
  frame.addEventListener("load", () => {
    try {
      const document = frame.contentDocument;
      if (!document || document.location.href === "about:blank") return;
      const result = JSON.parse(document.body.textContent || "");
      onError(result.error || "Не удалось экспортировать древо.");
      frame.remove();
    } catch {
      onError("Не удалось экспортировать древо: сервер вернул неожиданный ответ.");
      frame.remove();
    }
  });
  document.body.append(frame);
  const target = frame.contentDocument!;
  // A navigation POST from a no-referrer document sends Origin: null. Keep
  // strict CSRF checks and streaming downloads by submitting from a same-origin
  // frame whose referrer policy permits only same-origin referrers.
  const policy = target.createElement("meta");
  policy.name = "referrer";
  policy.content = "same-origin";
  target.head.append(policy);
  const form = target.createElement("form");
  form.hidden = true;
  form.method = "POST";
  form.action = archiveResourceUrl(`/api/gedcom/export-visible?format=${format}`);
  form.target = frame.name;
  const field = target.createElement("input");
  field.type = "hidden";
  field.name = "ids";
  field.value = JSON.stringify(personIds);
  form.append(field);
  target.body.append(form);
  form.submit();
  form.remove();
  window.setTimeout(() => frame.remove(), 5 * 60_000);
}
