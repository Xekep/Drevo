import { fullName, plural } from "./dates.ts";
import { analyzeKinship as analyzeKinshipBase } from "./kinship.ts";
import { unionStatus } from "./family-unions.ts";
import type { FamilyLink, FamilyUnion, Person, Relation } from "./types.ts";

function joinedNames(people: Person[]) {
  const names = people.map(fullName).sort((a, b) => a.localeCompare(b, "ru"));
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
  unions: FamilyUnion[] = [],
): Relation {
  const relation = analyzeKinshipBase(a, b, people, links);

  if (relation.kind === "marriage" && relation.path.length === 2) {
    const pair = unions.filter(
      (union) =>
        union.participants.includes(a.id) && union.participants.includes(b.id),
    );
    const statuses = pair.map((union) => unionStatus(union));
    const status = statuses.includes("current")
      ? "current"
      : statuses.length && statuses.every((item) => item === "former")
        ? "former"
        : "unknown";
    const role = (person: Person) =>
      status === "former"
        ? person.sex === "m"
          ? "бывший муж"
          : person.sex === "f"
            ? "бывшая жена"
            : "бывший супруг / супруга"
        : status === "current"
          ? person.sex === "m"
            ? "муж"
            : person.sex === "f"
              ? "жена"
              : "супруг / супруга"
          : "супруг / супруга (статус неизвестен)";
    return {
      ...relation,
      title:
        status === "former"
          ? "Бывшие супруги"
          : status === "current"
            ? "Супруги"
            : "Супруги и партнёры",
      explanation:
        status === "former"
          ? "Окончание союза этой пары записано в архиве."
          : status === "current"
            ? "Действующий союз этой пары подтверждён отдельной записью."
            : "Связь пары записана в архиве; действующий статус не подтверждён.",
      roles: [
        { term: role(a), description: "Статус по записи семейного союза." },
        { term: role(b), description: "Статус по записи семейного союза." },
      ],
    };
  }

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
