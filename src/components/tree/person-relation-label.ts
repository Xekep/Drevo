import { analyzeKinship, type FamilyLink, type Person } from "../../domain";

export function personRelationLabel(
  person: Person,
  reference: Person | null,
  people: Person[],
  links: FamilyLink[],
) {
  if (!reference) return "Нет привязки к древу";
  if (person.id === reference.id) return "Это вы";
  const relation = analyzeKinship(person, reference, people, links);
  const label =
    relation.roles?.[0]?.term ||
    (relation.kind === "unknown" ? "Родство не установлено" : "Семейная связь");
  return label[0].toLocaleUpperCase("ru") + label.slice(1);
}
