export type DocumentDetails = {
  documentType: string;
  documentDate: string;
  place: string;
  description: string;
  provenance: string;
};

const limits: Record<keyof DocumentDetails, number> = {
  documentType: 80,
  documentDate: 80,
  place: 200,
  description: 1000,
  provenance: 500,
};

export function parseDocumentDetails(input: unknown): DocumentDetails | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const result = {} as DocumentDetails;
  for (const key of Object.keys(limits) as Array<keyof DocumentDetails>) {
    const raw = source[key];
    if (raw !== undefined && typeof raw !== "string") return null;
    const value = (raw || "").trim();
    if (value.length > limits[key]) return null;
    result[key] = value;
  }
  return result;
}

export function documentSearchText(title: string, details: DocumentDetails): string {
  return [title, details.documentType, details.documentDate, details.place, details.description, details.provenance]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("ru");
}
