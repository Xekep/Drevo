import { normalizeDateInput } from "./dates.ts";
import { validateUnions } from "./family-unions.ts";
import type { Family, FamilyUnion } from "./types.ts";

/** Only the two edited dates are applied; concurrent notes and sources survive. */
export function applyPersonUnionDrafts(
  family: Family,
  personId: string,
  baseline: FamilyUnion[],
  drafts: FamilyUnion[],
): Family {
  if (!drafts.length) return family;
  const unions = [...(family.unions || [])];
  let changed = false;
  for (const draft of drafts) {
    const base = baseline.find((item) => item.id === draft.id);
    const dates = {
      formation: normalizeDateInput(draft.formation?.date || "") || undefined,
      divorce: normalizeDateInput(draft.divorce?.date || "") || undefined,
    };
    const keys = (["formation", "divorce"] as const).filter(
      (key) => dates[key] !== base?.[key]?.date,
    );
    if (!keys.length) continue;
    const index = unions.findIndex((item) => item.id === draft.id);
    const fresh = unions[index];
    if (
      base &&
      (!fresh ||
        fresh.type !== base.type ||
        !base.participants.every((id) => fresh.participants.includes(id)))
    )
      throw new Error(
        "Союз изменился в архиве. Обновите карточку и повторите правку.",
      );
    if (!draft.participants.includes(personId) || draft.type !== "marriage")
      throw new Error("Укажите существующий брак этого человека.");
    if (!base) {
      const partnerId = draft.participants.find((id) => id !== personId)!;
      const person = family.people.find((item) => item.id === personId);
      const partner = family.people.find((item) => item.id === partnerId);
      const linkedUnion = unions.some(
        (union) =>
          union.participants.includes(personId) &&
          union.participants.includes(partnerId),
      );
      if (
        !person ||
        !partner ||
        (!person.spouses.includes(partnerId) &&
          !partner.spouses.includes(personId) &&
          !linkedUnion)
      )
        throw new Error("Сначала добавьте супруга в семейные связи.");
      if (fresh) throw new Error("Этот союз уже создан. Обновите карточку.");
      if (
        unions.some(
          (union) =>
            union.type === "marriage" &&
            union.participants.includes(personId) &&
            union.participants.includes(partnerId) &&
            !baseline.some((old) => old.id === union.id),
        )
      )
        throw new Error(
          "Брак с этим человеком уже добавлен другим участником. Обновите карточку.",
        );
    }
    const next: FamilyUnion = structuredClone(fresh || draft);
    for (const key of keys) {
      if (
        base &&
        fresh?.[key]?.date !== base[key]?.date &&
        fresh?.[key]?.date !== dates[key]
      )
        throw new Error(
          "Дата брака или развода изменена другим участником. Обновите карточку.",
        );
      if (key === "divorce" && dates[key] && next.ending)
        throw new Error(
          "У союза уже указано другое окончание. Измените его в семейных союзах.",
        );
      next[key] = { ...next[key], date: dates[key], confidence: undefined };
      // Clearing a date must not erase an undated divorce or its evidence.
      if (Object.values(next[key]!).every((value) => value === undefined))
        delete next[key];
    }
    if (index < 0) unions.push(next);
    else unions[index] = next;
    changed = true;
  }
  if (!changed) return family;
  validateUnions(unions, new Set(family.people.map((person) => person.id)));
  return { ...family, unions };
}
