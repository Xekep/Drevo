import { dateBound, validDate } from "./dates.ts";
import type { FamilyUnion, Source, UnionMilestone } from "./types.ts";

export type UnionStatus = "current" | "former" | "unknown";

/** An undated or person-only event cannot identify a particular union's status. */
export function unionStatus(
  union: FamilyUnion,
  asOf = new Date().toISOString().slice(0, 10),
): UnionStatus {
  if (
    union.formation?.date &&
    dateBound(asOf, true) < dateBound(union.formation.date, false)
  )
    return "unknown";
  const ended = union.divorce || union.ending;
  if (
    ended &&
    (!ended.date || dateBound(ended.date, true) < dateBound(asOf, false))
  )
    return "former";
  // A confirmation from an earlier day proves that day's state, not today's.
  if (
    union.ongoing?.date === asOf &&
    /^\d{4}-\d{2}-\d{2}$/.test(asOf) &&
    (!ended ||
      (ended.date && dateBound(asOf, true) < dateBound(ended.date, false)))
  )
    return "current";
  return "unknown";
}

const validSources = (sources: Source[] | undefined) =>
  sources === undefined ||
  (Array.isArray(sources) &&
    sources.every(
      (s) =>
        s &&
        (s.catalogId === undefined ||
          (typeof s.catalogId === "string" &&
            /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s.catalogId))) &&
        typeof s.title === "string" &&
        typeof s.type === "string" &&
        typeof s.reference === "string" &&
        (s.url === undefined || typeof s.url === "string") &&
        (s.note === undefined || typeof s.note === "string") &&
        (s.documentId === undefined ||
          (typeof s.documentId === "string" &&
            /^[a-f0-9-]{36}$/i.test(s.documentId))) &&
        (s.documentPage === undefined ||
          (s.documentId &&
            Number.isInteger(s.documentPage) &&
            s.documentPage >= 1 &&
            s.documentPage <= 2000)),
    ));

function validMilestone(value: UnionMilestone | undefined) {
  return (
    value === undefined ||
    (value &&
      typeof value === "object" &&
      (value.date === undefined ||
        (typeof value.date === "string" && validDate(value.date))) &&
      (value.dateText === undefined ||
        (typeof value.dateText === "string" && value.dateText.length <= 500)) &&
      (value.place === undefined ||
        (typeof value.place === "string" && value.place.length <= 1000)) &&
      validSources(value.sources))
  );
}

export function validateUnions(
  unions: FamilyUnion[] | undefined,
  people: Set<string>,
) {
  if (unions === undefined) return;
  if (!Array.isArray(unions) || unions.length > 10000)
    throw new Error("Некорректный список семейных союзов");
  const ids = new Set<string>();
  for (const union of unions) {
    if (
      !union ||
      typeof union.id !== "string" ||
      !union.id ||
      ids.has(union.id) ||
      !Array.isArray(union.participants) ||
      union.participants.length !== 2 ||
      !union.participants.every(
        (id) => typeof id === "string" && people.has(id),
      ) ||
      union.participants[0] === union.participants[1] ||
      !["marriage", "civil_union", "partnership"].includes(union.type) ||
      (union.createdBy !== undefined && typeof union.createdBy !== "string") ||
      (union.note !== undefined &&
        (typeof union.note !== "string" || union.note.length > 10000)) ||
      !validSources(union.sources) ||
      !validMilestone(union.formation) ||
      !validMilestone(union.ending) ||
      !validMilestone(union.divorce) ||
      !validMilestone(union.ongoing) ||
      (union.divorce !== undefined && union.ending !== undefined) ||
      (union.divorce !== undefined && union.type !== "marriage")
    )
      throw new Error("Некорректный семейный союз");
    const first = union.formation?.date;
    const last = (union.divorce || union.ending)?.date;
    if (first && last && dateBound(first, false) > dateBound(last, true))
      throw new Error("Окончание союза не может быть раньше заключения");
    if (
      union.ongoing?.date &&
      last &&
      dateBound(union.ongoing.date, false) > dateBound(last, true)
    )
      throw new Error("Подтверждение действующего союза позже его окончания");
    ids.add(union.id);
  }
}
