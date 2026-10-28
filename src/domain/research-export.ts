import { isArchiveOwner, type ArchiveUser } from "./access.ts";
import type { Family } from "./types.ts";
import type { ResearchFile } from "../shared/research-protocol.ts";

export const PREPARE_ARCHIVE_EXPORT_TOOL = {
  name: "prepare_archive_export",
  description: "Подготовить ссылку на экспорт архива, а не PDF-отчёт из текста. format=options перечисляет доступные форматы. tree_pdf запускает клиентский векторный PDF текущего вида (scope=current) или всего разрешённого древа (all); gedcom7/gedcom551 выгружают доступные генеалогические данные без медиа; gedzip7 — настоящий GEDZIP с оригиналами, доступный только владельцу древа. lineage — текстовая роспись предков/потомков personId, сначала найди человека инструментом. Файл строится при скачивании с повторной проверкой доступа. Не подменяй недоступный формат другим без просьбы пользователя.",
  inputSchema: {
    type: "object",
    properties: {
      format: { type: "string", enum: ["options", "tree_pdf", "gedcom7", "gedcom551", "gedzip7", "lineage"] },
      scope: { type: "string", enum: ["current", "all"], description: "Только для tree_pdf: текущий показ или всё разрешённое древо. По умолчанию current." },
      personId: { type: "string", minLength: 1, maxLength: 200, description: "Доступный человек для lineage; также позволяет включить роспись в options." },
      direction: { type: "string", enum: ["ancestors", "descendants"], description: "Для lineage/options; по умолчанию ancestors." },
    },
    required: ["format"],
    additionalProperties: false,
  },
} as const;

type ExportContext = {
  family: Pick<Family, "people">;
  actor: ArchiveUser;
  pdfEnabled: boolean;
  selectedPersonId?: string;
};

/** A pure link contract. Download handlers, not the model, own bytes and rights.
 * There is deliberately no interpretation of the user's wording here.
 */
export function prepareArchiveExport(value: unknown, context: ExportContext): {
  answer: string;
  files: ResearchFile[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Укажите параметры экспорта");
  const args = value as Record<string, unknown>;
  const schema = PREPARE_ARCHIVE_EXPORT_TOOL.inputSchema;
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) ||
      !(schema.properties.format.enum as readonly unknown[]).includes(args.format))
    throw new Error("Неизвестный формат или параметр экспорта");
  if (args.scope !== undefined && (args.format !== "tree_pdf" ||
      !(schema.properties.scope.enum as readonly unknown[]).includes(args.scope)))
    throw new Error("Область current/all задаётся только для PDF древа");
  if (args.direction !== undefined &&
      (!(schema.properties.direction.enum as readonly unknown[]).includes(args.direction) ||
       (args.format !== "lineage" && args.format !== "options")))
    throw new Error("Направление задаётся для росписи предков или потомков");
  if (args.personId !== undefined && (typeof args.personId !== "string" ||
      !args.personId.trim() || args.personId.length > 200 || /[\p{Cc}]/u.test(args.personId) ||
      (args.format !== "lineage" && args.format !== "options")))
    throw new Error("Некорректный человек для росписи");
  const personId = typeof args.personId === "string" ? args.personId : context.selectedPersonId;
  const personAvailable = !!personId && context.family.people.some(person => person.id === personId);
  if (args.personId !== undefined && !personAvailable)
    throw new Error("Человек не найден или недоступен");
  const direction = args.direction === "descendants" ? "descendants" : "ancestors";
  const scope = args.scope === "all" ? "all" : "current";
  const treePdf = (selectedScope: "current" | "all"): ResearchFile => ({
    name: selectedScope === "all" ? "PDF всего древа" : "PDF видимого древа",
    url: `drevo:tree-pdf:${selectedScope}`,
  });
  const gedcom = (version: "gedcom7" | "gedcom551"): ResearchFile => ({
    name: version === "gedcom551" ? "GEDCOM 5.5.1" : "GEDCOM 7",
    url: `/api/ai/export/gedcom?format=${version}`,
  });
  // Match gedcomHttp's actual owner check, including an explicit false grant.
  const mayExportMedia = !!context.actor.approved && isArchiveOwner(context.actor);
  const gedzip: ResearchFile = { name: "GEDZIP 7", url: "/api/gedcom/export?format=gedzip7" };
  const lineage: ResearchFile | undefined = personAvailable ? {
    name: direction === "descendants" ? "Роспись потомков" : "Роспись предков",
    url: `/api/ai/export/lineage?personId=${encodeURIComponent(personId!)}&direction=${direction}`,
  } : undefined;
  switch (args.format) {
    case "tree_pdf": return context.pdfEnabled
      ? { answer: "PDF древа будет создан в браузере при нажатии «Скачать». Это команда экспорта выбранного вида, а не уже готовый файл.", files: [treePdf(scope)] }
      : { answer: "Создание PDF через ИИ отключено для вашей роли.", files: [] };
    case "gedcom7":
    case "gedcom551": return { answer: "Генеалогический файл содержит данные из доступной вам части архива без вложений.", files: [gedcom(args.format)] };
    case "gedzip7": return mayExportMedia
      ? { answer: "GEDZIP с оригиналами фотографий и документов можно скачать. Права владельца будут проверены повторно.", files: [gedzip] }
      : { answer: "GEDZIP с медиа доступен владельцу древа. Для обмена без вложений можно отдельно выбрать GEDCOM 7 или GEDCOM 5.5.1.", files: [] };
    case "lineage": return lineage
      ? { answer: "Роспись доступна для выбранного человека.", files: [lineage] }
      : { answer: "Выберите доступного человека, для которого нужна роспись.", files: [] };
    default: return {
      answer: "Выберите формат экспорта. GEDCOM и роспись используют только разрешённые вам данные; PDF сохраняет вид древа. GEDZIP с оригиналами доступен владельцу.",
      files: [...(context.pdfEnabled ? [treePdf("current"), treePdf("all")] : []),
        gedcom("gedcom7"), gedcom("gedcom551"), ...(mayExportMedia ? [gedzip] : []), ...(lineage ? [lineage] : [])],
    };
  }
}
