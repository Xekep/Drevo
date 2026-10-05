import type { Family, Person, PersonValueClaim } from "./types.ts";
import { removeConnections } from "./mutations.ts";
import type { Connection } from "./mutations.ts";

function sameValue(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const claimKeys = ["birthDateClaim", "deathDateClaim", "birthPlaceClaim",
  "deathPlaceClaim", "occupationClaim", "maidenNameClaim"] as const;
function isClaimKey(key: string): key is typeof claimKeys[number] {
  return claimKeys.some((claimKey) => claimKey === key);
}
function claimChanged(): never {
  throw new Error("Утверждение изменилось в архиве. Обновите карточку и повторите правку.");
}

function rebaseClaim(base: PersonValueClaim | undefined,
  fresh: PersonValueClaim | undefined, draft: PersonValueClaim | undefined,
): PersonValueClaim | undefined {
  if (sameValue(base, fresh)) return draft;
  if (sameValue(base, draft)) return fresh;
  // Sources and assessment refer to one particular value. Never combine them
  // across a concurrent value change or silently discard a changed claim.
  if (!base || !fresh || !draft || fresh.value !== draft.value) return claimChanged();
  const next = structuredClone(fresh);
  for (const key of ["sources", "confidence"] as const) {
    const edited = !sameValue(base[key], draft[key]);
    if (!edited) continue;
    if (!sameValue(base[key], fresh[key]) && !sameValue(draft[key], fresh[key]))
      return claimChanged();
    if (key === "sources") next.sources = structuredClone(draft.sources);
    else next.confidence = draft.confidence;
  }
  return next;
}

/** Переносит только изменённые поля черновика на свежую серверную карточку. */
export function rebasePersonDraft(
  base: Person | undefined,
  fresh: Person | undefined,
  draft: Person,
): Person {
  if (!base || !fresh || base.id !== draft.id || fresh.id !== draft.id)
    return draft;
  const next = structuredClone(fresh) as Person & Record<string, unknown>;
  const old = base as Person & Record<string, unknown>;
  const edited = draft as Person & Record<string, unknown>;
  for (const key of new Set([...Object.keys(old), ...Object.keys(edited)])) {
    if (sameValue(old[key], edited[key])) continue;
    if (isClaimKey(key)) {
      const claim = rebaseClaim(old[key] as PersonValueClaim | undefined,
        next[key] as PersonValueClaim | undefined,
        edited[key] as PersonValueClaim | undefined);
      if (claim) next[key] = claim;
      else delete next[key];
    } else if ((key === "events" || key === "factAlternatives" || key === "parentClaims" ||
      key === "awards") &&
      !sameValue(old[key], next[key]) && !sameValue(edited[key], next[key])) {
      // These arrays contain independent values, citations, and assessments.
      // Replacing a concurrently edited array could discard another editor's
      // source even when neither editor assigned a confidence status.
      claimChanged();
    } else if (key in edited) next[key] = structuredClone(edited[key]);
    else delete next[key];
  }
  return next;
}

/** Person fields and staged relation removals form one archive change. */
export function applyPersonDraft(
  family: Family,
  person: Person,
  removed: Connection[],
): Family {
  const exists = family.people.some((p) => p.id === person.id);
  const next = {
    ...family,
    people: exists
      ? family.people.map((p) => (p.id === person.id ? person : p))
      : [...family.people, person],
  };
  return removed.length ? removeConnections(next, removed) : next;
}
