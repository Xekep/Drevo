import type { Connection } from "./mutations.ts";
import type { Person, FamilyLink } from "./types.ts";
import { dateBound, validDate, fullName } from "./dates.ts";
import { parentHints } from "./name-hints.ts";

/** Только первоначальное предложение; возраст не доказывает сам факт родства. */
export function suggestConnectionOrder<T extends Connection>(
  draft: T,
  people: Person[],
  links: FamilyLink[] = [],
): T & { hint?: string } {
  if (draft.type !== "parent") return draft;
  const a = people.find((p) => p.id === draft.from),
    b = people.find((p) => p.id === draft.to);
  if (!a || !b || a.id === b.id) return draft;
  if (validDate(a.birth) && validDate(b.birth)) {
    const parent =
      dateBound(a.birth, true) < dateBound(b.birth, false)
        ? a
        : dateBound(b.birth, true) < dateBound(a.birth, false)
          ? b
          : undefined;
    if (parent)
      return {
        ...draft,
        from: parent.id,
        to: parent.id === a.id ? b.id : a.id,
        hint: `По датам рождения ${fullName(parent)} старше: предлагаем его родителем. Возраст сам по себе не подтверждает родство.`,
      };
  }
  const hints = parentHints(a, people, links).filter(
    (h) => h.person.id === b.id,
  );
  return hints.length === 1
    ? { ...draft, from: hints[0].from, to: hints[0].to, hint: hints[0].reason }
    : draft;
}
