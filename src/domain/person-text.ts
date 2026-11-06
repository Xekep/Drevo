import type { Change } from "./changes.ts";
import type { Family, Person } from "./types.ts";

const textFields = ["surname", "name", "patronymic", "maidenName",
  "birthPlace", "deathPlace", "occupation"] as const;
const claims = {
  maidenName: "maidenNameClaim", birthPlace: "birthPlaceClaim",
  deathPlace: "deathPlaceClaim", occupation: "occupationClaim",
} as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Trim short card fields at save time; prose, IDs and internal spacing are facts. */
export function normalizePersonText(person: Person, previous?: Person): Person {
  const next = { ...person };
  for (const field of textFields) {
    const value = person[field];
    if (typeof value !== "string") continue;
    const claimKey = field in claims ? claims[field as keyof typeof claims] : null;
    const claim = claimKey ? person[claimKey] : undefined;
    const oldClaim = claimKey ? previous?.[claimKey] : undefined;
    // A full or partial save must not silently clean unrelated existing cards.
    if (previous && value === previous[field] && claim?.value === oldClaim?.value) continue;
    next[field] = value.trim();
    // Only whitespace-equivalent values can retain their evidence. A different
    // value remains a validation error instead of inheriting another fact's source.
    if (claimKey && isRecord(claim) && typeof claim.value === "string" &&
      claim.value.trim() === value.trim())
      next[claimKey] = { ...claim, value: value.trim() };
  }
  return next;
}

/** Runs before validation without coercing malformed input into a valid card. */
export function normalizeArchivePersonText(value: unknown, previous?: Family): unknown {
  if (!isRecord(value) || !Array.isArray(value.people)) return value;
  const old = new Map(previous?.people.map(person => [person.id, person]));
  return { ...value, people: value.people.map(person => isRecord(person)
    ? normalizePersonText(person as Person, old.get(person.id as string)) : person) };
}

/** Keep the exact before-values for conflict checks; canonical after-values make retries idempotent. */
export function normalizePersonTextChanges(changes: Change[]): Change[] {
  return changes.map(change => {
    if (change.collection !== "people") return change;
    let after = change.after;
    if (!change.field && isRecord(after))
      after = normalizePersonText(after as Person,
        isRecord(change.before) ? change.before as Person : undefined);
    else if (textFields.some(field => field === change.field) && typeof after === "string")
      after = after.trim();
    else if (Object.values(claims).some(field => field === change.field) &&
      isRecord(after) && typeof after.value === "string")
      after = { ...after, value: after.value.trim() };
    return { ...change, after };
  });
}
