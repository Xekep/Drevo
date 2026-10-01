/** A URL-addressable subset of family IDs, retaining the existing 100-character publication limit. */
export function publicPersonId(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 100 ||
      value === "." || value === ".." || /[\p{Cc}/%\\]/u.test(value)) return false;
  try { encodeURIComponent(value); return true; }
  catch { return false; }
}

/** Decode exactly one path segment. Percent escapes cannot survive for a second decode. */
export function decodePublicPersonId(segment: string): string | null {
  if (!segment || segment.length > 1200) return null;
  try {
    const decoded = decodeURIComponent(segment);
    return publicPersonId(decoded) ? decoded : null;
  } catch { return null; }
}
