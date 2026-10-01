export type DocumentEventLink = {
  personId: string;
  eventId: string;
  page?: number;
};

export type DocumentPage = {
  number: number;
  description: string;
};

export function parseDocumentEventLinks(value: unknown): DocumentEventLink[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const seen = new Set<string>();
  const result: DocumentEventLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { personId, eventId, page } = item as Record<string, unknown>;
    if (typeof personId !== "string" || !personId || personId.length > 200 ||
        typeof eventId !== "string" || !eventId || eventId.length > 200 ||
        (page !== undefined && (!Number.isInteger(page) || Number(page) < 1 || Number(page) > 2000))) return null;
    const key = `${personId}\u0000${eventId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    result.push({ personId, eventId, ...(page === undefined ? {} : { page: Number(page) }) });
  }
  return result;
}

export function parseDocumentPages(value: unknown): DocumentPage[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const seen = new Set<number>();
  const result: DocumentPage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { number, description } = item as Record<string, unknown>;
    if (!Number.isInteger(number) || Number(number) < 1 || Number(number) > 2000 ||
        typeof description !== "string" || description.trim().length > 300 || seen.has(Number(number))) return null;
    seen.add(Number(number));
    result.push({ number: Number(number), description: description.trim() });
  }
  return result.sort((a, b) => a.number - b.number);
}
