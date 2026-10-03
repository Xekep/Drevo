import {
  analyzeKinship,
  createKinshipAnalyzer,
} from "../../domain/kinship-analysis.ts";
import type {
  FamilyLink,
  FamilyUnion,
  Person,
  Relation,
} from "../../domain/types.ts";

function relationLabel(relation: Relation) {
  const label =
    relation.roles?.[0]?.term ||
    (relation.kind === "unknown" ? "Родство не установлено" : "Семейная связь");
  return label[0].toLocaleUpperCase("ru") + label.slice(1);
}

/** Только поля, влияющие на родство/объяснение. Фото и страницы подробностей не сбрасывают кеш. */
export function kinshipLabelKey(
  people: Person[],
  links: FamilyLink[],
  unions: FamilyUnion[],
  day: string,
  readScope = "",
) {
  return JSON.stringify({
    day,
    readScope,
    people: people.map(
      ({
        id,
        surname,
        name,
        patronymic,
        sex,
        parents,
        spouses,
        parentageComplete,
      }) => ({
        id,
        surname,
        name,
        patronymic,
        sex,
        parents,
        spouses,
        parentageComplete,
      }),
    ),
    links: links.map(({ id, from, to, type, note, twinKind }) => ({
      id,
      from,
      to,
      type,
      note,
      twinKind,
    })),
    unions: unions.map(
      ({ id, participants, type, formation, ending, divorce, ongoing }) => ({
        id,
        participants,
        type,
        formation: formation && { date: formation.date },
        ending: ending && { date: ending.date },
        divorce: divorce && { date: divorce.date },
        ongoing: ongoing && { date: ongoing.date },
      }),
    ),
  });
}

/** Данные замыкания не ссылаются на меняемые карточки. Один анализатор на семантический снимок. */
export function createPersonRelationLabels(
  key: string,
  referenceId: string | undefined,
) {
  type LabelPerson = Pick<
    Person,
    | "id"
    | "surname"
    | "name"
    | "patronymic"
    | "sex"
    | "parents"
    | "spouses"
    | "parentageComplete"
  >;
  const snapshot = JSON.parse(key) as {
    day: string;
    people: LabelPerson[];
    links: FamilyLink[];
    unions: FamilyUnion[];
  };
  const people = snapshot.people.map((person): Person => ({
    ...person,
    birth: "",
    birthPlace: "",
    generation: 0,
    column: 0,
    sources: [],
  }));
  const reference = people.find((person) => person.id === referenceId);
  if (!reference) return () => "";
  const analyze = createKinshipAnalyzer(
    people,
    snapshot.links,
    snapshot.unions,
    snapshot.day,
  );
  const labels = new Map<string, string>();
  const byId = new Map(people.map((person) => [person.id, person]));
  return (person: Person) => {
    if (person.id === reference.id) return "Это вы";
    const cached = labels.get(person.id);
    if (cached !== undefined) return cached;
    // Исчезающая карточка прошлого графа не подтверждает родство в текущем снимке.
    const recorded = byId.get(person.id);
    if (!recorded) return "Родство не установлено";
    const label = relationLabel(analyze(recorded, reference));
    labels.set(person.id, label);
    return label;
  };
}

export function personRelationLabel(
  person: Person,
  reference: Person | null,
  people: Person[],
  links: FamilyLink[],
  unions: FamilyUnion[] = [],
) {
  if (!reference) return "";
  if (person.id === reference.id) return "Это вы";
  const relation = analyzeKinship(person, reference, people, links, unions);
  return relationLabel(relation);
}
