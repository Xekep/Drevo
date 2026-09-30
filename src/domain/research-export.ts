import type { ResearchFile } from "../shared/research-protocol.ts";

/** Recognise explicit file requests; never infer permission to export from archive content. */
export function requestedArchiveExport(
  message: string,
  personId?: string,
  pdfEnabled = true,
): {
  answer: string;
  files: ResearchFile[];
} | null {
  const request =
    /(?:экспорт|выгруз|скача|сохрани.{0,25}файл|(?:сделай|создай|сформируй|подготовь|дай).{0,45}(?:файл|pdf|пдф|gedcom|гедком|роспис))/iu.test(
      message,
    );
  const tree =
    /(?:древ|дерев|родословн)/iu.test(message) ||
    (/(?:экспорт|выгруз)/iu.test(message) &&
      /(?:pdf|пдф)/iu.test(message) &&
      !/отч[её]т/iu.test(message));
  const gedcom = /(?:gedcom|gedzip|гедком|гео.?формат)/iu.test(message);
  const lineage = /роспис/iu.test(message);
  const generic =
    /^(?:сделай|создай|сформируй|подготовь|дай)?\s*экспорт\s*(?:древа|дерева|архива)?[.!?]?$/iu.test(
      message,
    );
  if (!request || !(tree || gedcom || lineage || generic)) return null;

  const pdf = /(?:pdf|пдф)/iu.test(message);
  const format551 = /5[.]5[.]1/iu.test(message);
  const all =
    /(?:вс[её](?:го)?\s+древ|полност[ьюи]\s+древ|со\s+всеми\s+ветв)/iu.test(
      message,
    );
  const direction = /потомк/iu.test(message) ? "descendants" : "ancestors";
  const scope = all ? "all" : "current";
  const treePdf: ResearchFile = {
    name: all ? "PDF всего древа" : "PDF видимого древа",
    url: `drevo:tree-pdf:${scope}`,
  };
  const gedcomFile: ResearchFile = {
    name: format551 ? "GEDCOM 5.5.1" : "GEDCOM 7",
    url: `/api/ai/export/gedcom?format=${format551 ? "gedcom551" : "gedcom7"}`,
  };
  const lineageFile: ResearchFile | null = personId
    ? {
        name:
          direction === "descendants" ? "Роспись потомков" : "Роспись предков",
        url: `/api/ai/export/lineage?personId=${encodeURIComponent(personId)}&direction=${direction}`,
      }
    : null;

  if (lineage && !tree && !gedcom)
    return lineageFile
      ? {
          answer: "Роспись подготовлена по выбранному человеку.",
          files: [lineageFile],
        }
      : {
          answer: "Выберите человека на древе, для которого нужна роспись.",
          files: [],
        };
  if (gedcom && !pdf)
    return {
      answer: "Генеалогический файл доступен для скачивания.",
      files: [gedcomFile],
    };
  if (pdf)
    return pdfEnabled
      ? { answer: "PDF древа можно скачать в текущем виде.", files: [treePdf] }
      : {
          answer: "Создание PDF через ИИ отключено для вашей роли.",
          files: [],
        };
  return {
    answer: pdfEnabled
      ? "Выберите формат экспорта. PDF сохраняет видимые или все ветви древа, GEDCOM содержит генеалогические данные из доступной вам части архива."
      : "Выберите формат экспорта. GEDCOM содержит генеалогические данные из доступной вам части архива; PDF через ИИ отключён для вашей роли.",
    files: [
      ...(pdfEnabled
        ? [treePdf, { name: "PDF всего древа", url: "drevo:tree-pdf:all" }]
        : []),
      gedcomFile,
      ...(lineageFile ? [lineageFile] : []),
    ],
  };
}
