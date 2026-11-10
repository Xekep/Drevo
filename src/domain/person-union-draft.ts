import { normalizeCalendarDate } from "./calendar-dates.ts";
import { validateUnions } from "./family-unions.ts";
import type { Family, FamilyUnion } from "./types.ts";
const sameDate = (a?: { date?: string; dateJulian?: string }, b?: { date?: string; dateJulian?: string }) =>
  a?.date === b?.date && a?.dateJulian === b?.dateJulian;

/** Apply date edits and explicit removals; preserve concurrent evidence or reject its deletion. */
export function applyPersonUnionDrafts(
  family: Family,
  personId: string,
  baseline: FamilyUnion[],
  drafts: FamilyUnion[],
  removedIds: string[] = [],
): Family {
  if (!drafts.length && !removedIds.length) return family;
  const unions = [...(family.unions || [])];
  let changed = false;
  const removed = new Set(removedIds);
  for (const id of removed) {
    const base = baseline.find(item => item.id === id);
    if (!base || base.type !== "marriage" || !base.participants.includes(personId))
      throw new Error("Укажите существующий брак этого человека.");
    const index = unions.findIndex(item => item.id === id);
    if (index < 0) continue;
    if (JSON.stringify(unions[index]) !== JSON.stringify(base))
      throw new Error("Брак изменён другим участником. Обновите карточку перед удалением.");
    unions.splice(index, 1);
    changed = true;
  }
  for (const draft of drafts) {
    if (removed.has(draft.id)) continue;
    const base = baseline.find((item) => item.id === draft.id);
    const dates = {
      formation: normalizeCalendarDate(draft.formation?.date, draft.formation?.dateJulian),
      divorce: normalizeCalendarDate(draft.divorce?.date, draft.divorce?.dateJulian),
    };
    const keys = (["formation", "divorce"] as const).filter(
      (key) => !sameDate(dates[key], base?.[key]),
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
        !sameDate(fresh?.[key], base[key]) &&
        !sameDate(fresh?.[key], dates[key])
      )
        throw new Error(
          "Дата брака или развода изменена другим участником. Обновите карточку.",
        );
      if (key === "divorce" && dates[key].date && next.ending)
        throw new Error(
          "У союза уже указано другое окончание. Измените его в семейных союзах.",
        );
      next[key] = { ...next[key], ...dates[key], confidence: undefined };
      if (next[key]!.dateJulian === undefined) delete next[key]!.dateJulian;
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
