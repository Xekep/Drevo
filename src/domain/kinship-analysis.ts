import { fullName, plural } from "./dates.ts";
import { createKinshipBaseAnalyzer } from "./kinship.ts";
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
  return createKinshipAnalyzer(people, links, unions)(a, b);
}

/**
 * Снимок семейного графа; кеш предков ограничен внутри замыкания.
 * a/b остаются явными аргументами: как у analyzeKinship, их исходный пол
 * определяет брачную роль, а имена участвуют в объяснении бокового родства.
 * asOf фиксирует UTC-день снимка; без него статус, как прежде, считается на день вызова.
 */
export function createKinshipAnalyzer(
  people: Person[],
  links: FamilyLink[] = [],
  unions: FamilyUnion[] = [],
  asOf?: string,
) {
  const map = new Map(
    people.map((person) => [
      person.id,
      { ...person, parents: [...person.parents], spouses: [...person.spouses] },
    ]),
  );
  const pairUnions = new Map<string, Map<string, FamilyUnion[]>>();
  for (const union of unions) {
    const snapshot = {
      ...union,
      participants: [...union.participants] as [string, string],
      formation: union.formation && { ...union.formation },
      ending: union.ending && { ...union.ending },
      divorce: union.divorce && { ...union.divorce },
      ongoing: union.ongoing && { ...union.ongoing },
    };
    for (const id of new Set(snapshot.participants)) {
      const byOther = pairUnions.get(id) || new Map<string, FamilyUnion[]>();
      for (const other of new Set(snapshot.participants)) {
        const records = byOther.get(other) || [];
        records.push(snapshot);
        byOther.set(other, records);
      }
      pairUnions.set(id, byOther);
    }
  }
  const analyze = createKinshipBaseAnalyzer(people, links);
  return (a: Person, b: Person): Relation =>
    normalizeKinship(
      a,
      b,
      analyze(a, b),
      map,
      pairUnions.get(a.id)?.get(b.id) || [],
      asOf,
    );
}

function normalizeKinship(
  a: Person,
  b: Person,
  relation: Relation,
  map: Map<string, Person>,
  pair: FamilyUnion[],
  asOf?: string,
): Relation {
  if (relation.kind === "marriage" && relation.path.length === 2) {
    const statuses = pair.map((union) => unionStatus(union, asOf));
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
