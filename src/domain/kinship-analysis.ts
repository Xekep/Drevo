import { fullName, plural } from "./dates.ts";
import { analyzeKinship as analyzeKinshipBase } from "./kinship.ts";
import type { FamilyLink, Person, Relation } from "./types.ts";

function joinedNames(people: Person[]) {
  const names = people
    .map(fullName)
    .sort((a, b) => a.localeCompare(b, "ru"));
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} и ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} и ${names[names.length - 1]}`;
}

/**
 * Нормализует пользовательское объяснение родства поверх расчёта графа.
 * Техническая вершина соединения пути не всегда является единственным
 * общим предком и вообще не должна называться общим предком в прямой линии.
 */
export function analyzeKinship(
  a: Person,
  b: Person,
  people: Person[],
  links: FamilyLink[] = [],
): Relation {
  const relation = analyzeKinshipBase(a, b, people, links);

  if (relation.kind === "direct")
    return {
      ...relation,
      // Родитель или другой прямой предок соединяет путь, но не является
      // «общим предком» самого себя и своего потомка в интерфейсе.
      common: [],
    };

  if (
    relation.kind !== "blood" ||
    !relation.common.length ||
    !relation.distances
  )
    return relation;

  const map = new Map(people.map((person) => [person.id, person]));
  const commonPeople = relation.common
    .map((id) => map.get(id))
    .filter((person): person is Person => Boolean(person));
  if (!commonPeople.length) return relation;

  const [da, db] = relation.distances;
  const commonLabel =
    commonPeople.length === 1
      ? `Общий предок — ${joinedNames(commonPeople)}.`
      : `Общие предки — ${joinedNames(commonPeople)}.`;
  const marriageNote =
    a.spouses.includes(b.id) || b.spouses.includes(a.id)
      ? " Также в архиве указан их брак."
      : "";

  return {
    ...relation,
    explanation: `${commonLabel} От ${a.name}: ${da} ${plural(da, "поколение", "поколения", "поколений")}, от ${b.name}: ${db} ${plural(db, "поколение", "поколения", "поколений")}.${marriageNote}`,
  };
}
