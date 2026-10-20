import type { Source } from "./types.ts";
import { archiveTargetPath } from "./archive-links.ts";
import { personSourceKey } from "./person-sources.ts";

/** Stable UI locator, not an authorization token. Whitespace normalization is
 * shared with the source summary; full source text never goes into the URL. */
export function researchEvidenceAnchor(
  kind: "event" | "source" | "union" | "birth" | "death",
  value: string | Source,
) {
  const text = typeof value === "string" ? value : personSourceKey(value);
  let a = 2166136261,
    b = 2246822507;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b ^ text.charCodeAt(i), 3266489909);
  }
  return `drevo-${kind}-${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
export function researchEvidencePath(personId: string, anchor: string) {
  return `${archiveTargetPath({ kind: "person", id: personId })}#${anchor}`;
}
