import type { Source } from "../domain/types.ts";
import { safeUrl, validDate } from "../domain/dates.ts";

export type CatalogSource = {
  id: string;
  title: string;
  type: string;
  author: string;
  institution: string;
  archive: string;
  fond: string;
  opis: string;
  delo: string;
  sheet: string;
  reference: string;
  url: string;
  accessedAt: string;
  description: string;
  documentIds: string[];
};

const fields = ["title", "type", "author", "institution", "archive", "fond",
  "opis", "delo", "sheet", "reference", "url", "accessedAt", "description"] as const;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseCatalogSource(value: unknown): CatalogSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !idPattern.test(input.id) ||
    fields.some((key) => typeof input[key] !== "string" ||
      (input[key] as string).length > (key === "description" ? 10_000 : 2_000)) ||
    !(input.title as string).trim() ||
    (input.url && (!/^https?:\/\/[^\s]+$/i.test(input.url as string) || !safeUrl(input.url as string))) ||
    (input.accessedAt && ((input.accessedAt as string).length !== 10 || !validDate(input.accessedAt))) ||
    !Array.isArray(input.documentIds) || input.documentIds.length > 100 ||
    input.documentIds.some((id) => typeof id !== "string" || !idPattern.test(id)) ||
    new Set(input.documentIds).size !== input.documentIds.length) return null;
  return Object.fromEntries([...fields.map((key) => [key, input[key]]),
    ["id", input.id], ["documentIds", input.documentIds]]) as CatalogSource;
}

export function sourceCitation(source: CatalogSource): Source {
  return {
    catalogId: source.id,
    title: source.title,
    type: source.type,
    reference: source.reference || [source.archive, source.fond, source.opis,
      source.delo, source.sheet].filter(Boolean).join(", "),
    ...(source.url ? { url: source.url } : {}),
    ...(source.description ? { note: source.description } : {}),
    ...(source.documentIds[0] ? { documentId: source.documentIds[0] } : {}),
  };
}
