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
      // A successful file download does not load a document into the frame.
    }
  });
  const form = document.createElement("form");
  form.hidden = true;
  form.method = "POST";
  form.action = archiveResourceUrl(`/api/gedcom/export-visible?format=${format}`);
  form.target = frame.name;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "ids";
  field.value = JSON.stringify(personIds);
  form.append(field);
  document.body.append(frame, form);
  form.submit();
  form.remove();
  window.setTimeout(() => frame.remove(), 5 * 60_000);
}
