import { dateInputLabel, fullName, validDate } from "./dates.ts";
import { householdLevels } from "./household-levels.ts";
import { EVENT_NAMES } from "./person-events.ts";
import { CONNECTION_NAMES } from "./mutations.ts";
import { CLAIM_CONFIDENCE_LABELS } from "./claim-confidence.ts";
import { repositorySummary } from "./person-sources.ts";
import type { Family, Person, Source, UnionMilestone } from "./types.ts";

const clean = (value = "") =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    )
    .trim();
const inline = (value = "") => clean(value).replace(/\s+/g, " ");
const compareText = (a: string, b: string) => a.localeCompare(b, "ru");
function comparePeople(a: Person, b: Person) {
  const aDate = validDate(a.birth) ? a.birth : "99999";
  const bDate = validDate(b.birth) ? b.birth : "99999";
  return (
    compareText(aDate, bDate) ||
    compareText(fullName(a), fullName(b)) ||
    compareText(a.id, b.id)
  );
}
function roman(value: number) {
  let result = "";
  for (const [number, symbol] of [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ] as const) {
    while (value >= number) {
      result += symbol;
      value -= number;
    }
  }
  return result;
}
const milestone = (value?: UnionMilestone) =>
  value
    ? [value.dateText || dateInputLabel(value.date || ""), value.place]
        .filter(Boolean)
        .map(inline)
        .join(", ")
    : "";

/** Traditional descending register: generation headings, continuous numbers and parent references.
 * All boundaries are applied before ordering, numbering or writing any relationship. */
export function generationReport(
  family: Family,
  visibleIds: ReadonlySet<string>,
) {
  const people = family.people.filter((person) => visibleIds.has(person.id));
  if (!people.length)
    throw new Error("В видимом древе нет людей для экспорта.");
  const byId = new Map(people.map((person) => [person.id, person]));
  const unions = (family.unions || []).filter((union) =>
    union.participants.every((id) => byId.has(id)),
  );
  const links = (family.links || []).filter(
    (link) => byId.has(link.from) && byId.has(link.to),
  );
  const spouses = new Map(
    people.map((person) => [
      person.id,
      new Set(person.spouses.filter((id) => byId.has(id))),
    ]),
  );
  for (const person of people)
    for (const spouse of spouses.get(person.id)!)
      spouses.get(spouse)!.add(person.id);
  for (const union of unions) {
    const [a, b] = union.participants;
    spouses.get(a)!.add(b);
    spouses.get(b)!.add(a);
  }
  const parents = new Map(
    people.map((person) => [
      person.id,
      [...new Set(person.parents.filter((id) => byId.has(id)))],
    ]),
  );
  const rankParents = new Map(
    [...parents].map(([id, values]) => [id, new Set(values)]),
  );
  for (const link of links)
    if (link.type === "adoptive_parent" || link.type === "foster_parent")
      rankParents.get(link.to)!.add(link.from);
  const levels = householdLevels(
    people.map((person) => ({
      id: person.id,
      birth: person.birth,
      parents: [...rankParents.get(person.id)!],
      spouses: [...spouses.get(person.id)!],
    })),
  );
  const groups = new Map<number, Person[]>();
  for (const person of people) {
    const level = levels.get(person.id)!;
    const group = groups.get(level) || [];
    group.push(person);
    groups.set(level, group);
  }
  const numbers = new Map<string, number>();
  const ordered = [...groups].sort(([a], [b]) => a - b);
  for (const [, group] of ordered) {
    const parentNumber = (person: Person) =>
      Math.min(
        ...parents.get(person.id)!.map((id) => numbers.get(id) || Infinity),
      );
    group.sort(
      (a, b) => parentNumber(a) - parentNumber(b) || comparePeople(a, b),
    );
    for (const person of group) numbers.set(person.id, numbers.size + 1);
  }
  const reference = (id: string) =>
    `№${numbers.get(id)} ${inline(fullName(byId.get(id)!))}`;
  const children = new Map(people.map((person) => [person.id, [] as Person[]]));
  for (const person of people)
    for (const id of parents.get(person.id)!) children.get(id)!.push(person);
  const personUnions = new Map(
    people.map((person) => [person.id, [] as typeof unions]),
  );
  for (const union of unions)
    for (const id of union.participants) personUnions.get(id)!.push(union);
  const personLinks = new Map(
    people.map((person) => [person.id, [] as typeof links]),
  );
  for (const link of links) personLinks.get(link.to)!.push(link);
  const lines = [
    "ПОКОЛЕННАЯ РОСПИСЬ",
    inline(family.title) || "Семейный архив",
    "",
    `Видимое древо. Людей: ${people.length}. Поколений: ${ordered.length}.`,
    "Поколения обозначены римскими цифрами, люди — сквозными арабскими номерами.",
    "В скобках после номера человека указаны номера его записанных биологических родителей.",
    "Самостоятельные ветви отсчитываются от своих старших поколений; супруги располагаются в одном поколении, когда родство это допускает.",
    "Номера и ссылки относятся только к людям этой росписи. Отсутствие сведений не означает отсутствие события.",
  ];
  const write = (label: string, value?: string) => {
    const text = clean(value);
    if (text) lines.push(`   ${label}: ${text.replace(/\n/g, "\r\n      ")}`);
  };
  const sources = (label: string, values?: Source[]) => {
    const seen = new Set<string>();
    for (const source of values || []) {
      const text = [
        source.title,
        source.type,
        source.reference,
        repositorySummary(source),
        source.url,
        source.note,
      ]
        .filter(Boolean)
        .map(inline)
        .join("; ");
      if (text && !seen.has(text)) {
        write(label, text);
        seen.add(text);
      }
    }
  };
  for (const [level, group] of ordered) {
    lines.push("", `Поколение ${roman(level + 1)}`, "");
    for (const person of group) {
      const parentIds = parents.get(person.id)!;
      const parentNumbers = parentIds
        .map((id) => numbers.get(id)!)
        .sort((a, b) => a - b);
      lines.push(
        `${numbers.get(person.id)}${parentNumbers.length ? ` (${parentNumbers.join(", ")})` : ""}. ${inline(fullName(person))}`,
      );
      if (person.needsReview) lines.push("   Данные требуют проверки.");
      write("Девичья фамилия", person.maidenName);
      write(
        "Род.",
        [dateInputLabel(person.birth), person.birthPlace]
          .filter(Boolean)
          .map(inline)
          .join(", "),
      );
      write(
        "Ум.",
        [dateInputLabel(person.death || ""), person.deathPlace]
          .filter(Boolean)
          .map(inline)
          .join(", ") || (person.deceased ? "дата неизвестна" : ""),
      );
      for (const id of [...parentIds].sort(
        (a, b) => numbers.get(a)! - numbers.get(b)!,
      )) {
        const sex = byId.get(id)!.sex;
        write(
          sex === "m" ? "Отец" : sex === "f" ? "Мать" : "Родитель",
          reference(id),
        );
      }
      for (const link of [...personLinks.get(person.id)!].sort((a, b) =>
        compareText(a.id, b.id),
      )) {
        write(
          CONNECTION_NAMES[link.type],
          `${reference(link.from)}${link.note ? `; ${inline(link.note)}` : ""}`,
        );
        sources("Источник связи", link.sources);
      }
      write("Занятие", person.occupation);
      write("Биография", person.biography);
      const recordedPartners = new Set<string>();
      for (const union of [...personUnions.get(person.id)!].sort(
        (a, b) =>
          compareText(
            a.formation?.date || "99999",
            b.formation?.date || "99999",
          ) || compareText(a.id, b.id),
      )) {
        const partner = union.participants.find((id) => id !== person.id)!;
        recordedPartners.add(partner);
        write(
          union.type === "marriage"
            ? "Брак"
            : union.type === "civil_union"
              ? "Гражданский союз"
              : "Партнёрство",
          reference(partner),
        );
        write("Заключение союза", milestone(union.formation));
        write("Развод", milestone(union.divorce));
        write("Завершение союза", milestone(union.ending));
        write("Союз продолжался", milestone(union.ongoing));
        write("Примечание к союзу", union.note);
        sources("Источник союза", [
          ...(union.sources || []),
          ...(union.formation?.sources || []),
          ...(union.divorce?.sources || []),
          ...(union.ending?.sources || []),
          ...(union.ongoing?.sources || []),
        ]);
      }
      for (const id of [...spouses.get(person.id)!]
        .filter((id) => !recordedPartners.has(id))
        .sort((a, b) => numbers.get(a)! - numbers.get(b)!))
        write("Супруг(а)", `${reference(id)}; подробности союза не записаны`);
      const descendants = children.get(person.id)!.sort(comparePeople);
      if (descendants.length)
        write(
          "Дети",
          descendants.map((child) => reference(child.id)).join("; "),
        );
      for (const event of [...(person.events || [])].sort(
        (a, b) =>
          compareText(a.date || "99999", b.date || "99999") ||
          compareText(a.id, b.id),
      )) {
        write(
          inline(event.title || EVENT_NAMES[event.type]),
          [
            event.dateText || dateInputLabel(event.date || ""),
            event.endDate ? `до ${dateInputLabel(event.endDate)}` : "",
            event.place,
            event.description,
          ]
            .filter(Boolean)
            .join("; ") || "дата неизвестна",
        );
        sources("Источник события", event.sources);
        sources("Источник места события", event.placeClaim?.sources);
      }
      for (const award of person.awards || []) {
        write("Награда", [award.name, award.year].filter(Boolean).join("; "));
        if (award.source)
          write(
            "Источник награды",
            [award.source.title, award.source.url].filter(Boolean).join("; "),
          );
      }
      sources("Источник", person.sources);
      for (const [label, claim] of [
        ["рождения", person.birthDateClaim],
        ["смерти", person.deathDateClaim],
        ["места рождения", person.birthPlaceClaim],
        ["места смерти", person.deathPlaceClaim],
      ] as const) {
        if (claim?.confidence)
          write(`Оценка ${label}`, CLAIM_CONFIDENCE_LABELS[claim.confidence]);
        sources(`Источник ${label}`, claim?.sources);
      }
      lines.push("");
    }
  }
  return lines.join("\r\n").trimEnd() + "\r\n";
}
