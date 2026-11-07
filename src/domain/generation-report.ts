import { dateInputLabel, fullName, validDate } from "./dates.ts";
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

const lifeDate = (date: string, julian?: string) =>
  julian
    ? `${julian.split("-").reverse().join(".")} (ст. ст.)${date && date !== julian ? ` / ${dateInputLabel(date)} (н. ст.)` : ""}`
    : dateInputLabel(date);

export type GenerationNumbering = "daboville" | "person-parent";

/** Descending register with selectable numbering. Authorization is applied before traversal.
 * Breadth-first numbering chooses the shortest path, then sibling order. */
export function generationReport(
  family: Family,
  visibleIds: ReadonlySet<string>,
  rootId?: string,
  numbering: GenerationNumbering = "daboville",
) {
  if (numbering !== "daboville" && numbering !== "person-parent")
    throw new Error("Неизвестная система нумерации.");
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
  const root = rootId
    ? byId.get(rootId)
    : [...people]
        .filter((person) => !parents.get(person.id)!.length)
        .sort(comparePeople)[0] || [...people].sort(comparePeople)[0];
  if (!root) throw new Error("Выберите доступного родоначальника для росписи.");
  const children = new Map(people.map((person) => [person.id, [] as Person[]]));
  for (const person of people)
    for (const id of parents.get(person.id)!) children.get(id)!.push(person);
  for (const values of children.values()) values.sort(comparePeople);
  const numbers = new Map<string, string>([[root.id, "1"]]);
  const primaryParents = new Map<string, string>();
  const groups = new Map<number, Person[]>();
  const queue = [{ person: root, depth: 0 }];
  for (let position = 0; position < queue.length; position++) {
    const { person, depth } = queue[position];
    const group = groups.get(depth) || [];
    group.push(person);
    groups.set(depth, group);
    for (const [ordinal, child] of children.get(person.id)!.entries()) {
      if (numbers.has(child.id)) continue;
      primaryParents.set(child.id, person.id);
      numbers.set(child.id, `${numbers.get(person.id)}.${ordinal + 1}`);
      queue.push({ person: child, depth: depth + 1 });
    }
  }
  const paths = new Map(numbers);
  if (numbering === "person-parent")
    queue.forEach(({ person }, index) =>
      numbers.set(person.id, String(index + 1)),
    );
  const headingNumber = (person: Person) => {
    const own = numbers.get(person.id)!;
    if (numbering === "daboville" || person.id === root.id) return own;
    const father = parents
      .get(person.id)!
      .find((id) => byId.get(id)!.sex === "m" && numbers.has(id));
    const parent = father || primaryParents.get(person.id);
    return parent ? `${own}.${numbers.get(parent)}` : own;
  };
  const ordered = [...groups];
  const personName = (person: Person) =>
    inline(fullName(person)) || "Имя неизвестно";
  const reference = (id: string) =>
    `${numbers.has(id) ? `№${numbers.get(id)} ` : ""}${personName(byId.get(id)!)}`;
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
    `Родоначальник: ${personName(root)}.`,
    `Потомки по мужским и женским линиям. Людей: ${numbers.size}. Поколений: ${ordered.length}.`,
    numbering === "daboville"
      ? "Нумерация д’Абовилля: 1; 1.1; 1.1.1. Супруги вне потомства отдельных номеров не получают."
      : "Российская традиционная нумерация: номер человека.номер родителя. Указывается отец из росписи; по женской линии — родитель основной ветви. Супруги вне потомства отдельных номеров не получают.",
    "* — рождение; + — смерть; × — брак; ~ — крещение; □ — погребение.",
    "Повторное появление человека ведёт к его основной записи по кратчайшей ветви; при равной длине — по порядку детей.",
    "Номера относятся только к этой росписи. Отсутствие сведений не означает отсутствие события.",
  ];
  const write = (label: string, value?: string) => {
    const text = clean(value);
    if (text)
      lines.push(
        `   ${label}${["*", "+", "×", "~", "□"].includes(label.trim()) ? "" : ":"} ${text.replace(/\n/g, "\r\n      ")}`,
      );
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
  const writeDetails = (person: Person, prefix = "") => {
    const detailWrite = (label: string, value?: string) =>
      write(prefix + label, value);
    const detailSources = (label: string, values?: Source[]) =>
      sources(prefix + label, values);
    for (const event of [...(person.events || [])].sort(
      (a, b) =>
        compareText(a.date || "99999", b.date || "99999") ||
        compareText(a.id, b.id),
    )) {
      detailWrite(
        event.type === "baptism"
          ? "~"
          : event.type === "burial"
            ? "□"
            : event.type === "marriage"
              ? "×"
              : inline(event.title || EVENT_NAMES[event.type]),
        [
          event.dateText || dateInputLabel(event.date || ""),
          event.endDate ? `до ${dateInputLabel(event.endDate)}` : "",
          event.place,
          event.description,
        ]
          .filter(Boolean)
          .join("; ") || "дата неизвестна",
      );
      detailSources("Источник события", event.sources);
      if (event.dateClaim?.confidence)
        detailWrite(
          "Оценка даты события",
          CLAIM_CONFIDENCE_LABELS[event.dateClaim.confidence],
        );
      detailSources("Источник даты события", event.dateClaim?.sources);
      if (event.placeClaim?.confidence)
        detailWrite(
          "Оценка места события",
          CLAIM_CONFIDENCE_LABELS[event.placeClaim.confidence],
        );
      detailSources("Источник места события", event.placeClaim?.sources);
      for (const alternative of event.alternatives || []) {
        detailWrite(
          alternative.field === "date"
            ? "Другая дата события"
            : "Другое место события",
          alternative.field === "date"
            ? dateInputLabel(alternative.value)
            : alternative.value,
        );
        if (alternative.confidence)
          detailWrite(
            "Оценка варианта",
            CLAIM_CONFIDENCE_LABELS[alternative.confidence],
          );
        detailSources("Источник варианта события", alternative.sources);
      }
    }
    for (const award of person.awards || []) {
      detailWrite(
        "Награда",
        [award.name, award.year].filter(Boolean).join("; "),
      );
      if (award.source)
        detailWrite(
          "Источник награды",
          [award.source.title, award.source.url].filter(Boolean).join("; "),
        );
      detailSources("Источник награды", award.sources);
    }
    detailSources("Источник", person.sources);
    for (const [label, claim] of [
      ["рождения", person.birthDateClaim],
      ["смерти", person.deathDateClaim],
      ["места рождения", person.birthPlaceClaim],
      ["места смерти", person.deathPlaceClaim],
      ["девичьей фамилии", person.maidenNameClaim],
      ["занятия", person.occupationClaim],
    ] as const) {
      if (claim?.confidence)
        detailWrite(
          `Оценка ${label}`,
          CLAIM_CONFIDENCE_LABELS[claim.confidence],
        );
      detailSources(`Источник ${label}`, claim?.sources);
    }
    for (const alternative of person.factAlternatives || []) {
      const labels = {
        birth: "рождения",
        death: "смерти",
        birthPlace: "места рождения",
        deathPlace: "места смерти",
        maidenName: "девичьей фамилии",
        occupation: "занятия",
      };
      detailWrite(
        `Другой вариант ${labels[alternative.field]}`,
        alternative.value,
      );
      if (alternative.confidence)
        detailWrite(
          "Оценка варианта",
          CLAIM_CONFIDENCE_LABELS[alternative.confidence],
        );
      detailSources("Источник варианта", alternative.sources);
    }
  };
  const partnerRecords = new Map<string, string>();
  const writePartner = (id: string, married: boolean, ownerId: string) => {
    const partner = byId.get(id)!;
    write(
      married
        ? partner.sex === "f"
          ? "Жена"
          : partner.sex === "m"
            ? "Муж"
            : "Супруг(а)"
        : "Партнёр / супруг(а)",
      reference(id),
    );
    if (numbers.has(id)) return;
    const previous = partnerRecords.get(id);
    if (previous) {
      write("  Сведения о человеке", `см. запись №${previous}`);
      return;
    }
    partnerRecords.set(id, numbers.get(ownerId)!);
    write(
      "  *",
      [lifeDate(partner.birth, partner.birthJulian), partner.birthPlace]
        .filter(Boolean)
        .join(", "),
    );
    write(
      "  +",
      [lifeDate(partner.death || "", partner.deathJulian), partner.deathPlace]
        .filter(Boolean)
        .join(", ") || (partner.deceased ? "дата неизвестна" : ""),
    );
    write("  Девичья фамилия", partner.maidenName);
    write("  Занятие", partner.occupation);
    write("  Биография", partner.biography);
    if (partner.needsReview) write("  Проверка", "Данные требуют проверки");
    writeDetails(partner, "  ");
  };
  for (const [level, group] of ordered) {
    lines.push("", `Поколение ${roman(level + 1)}`, "");
    for (const person of group) {
      const parentIds = parents.get(person.id)!;
      lines.push(`${headingNumber(person)}. ${personName(person)}`);
      if (person.needsReview) lines.push("   Данные требуют проверки.");
      write("Девичья фамилия", person.maidenName);
      write(
        "*",
        [lifeDate(person.birth, person.birthJulian), person.birthPlace]
          .filter(Boolean)
          .map(inline)
          .join(", "),
      );
      write(
        "+",
        [lifeDate(person.death || "", person.deathJulian), person.deathPlace]
          .filter(Boolean)
          .map(inline)
          .join(", ") || (person.deceased ? "дата неизвестна" : ""),
      );
      for (const id of [...parentIds].sort(
        (a, b) =>
          compareText(numbers.get(a) || "", numbers.get(b) || "") ||
          compareText(a, b),
      )) {
        const sex = byId.get(id)!.sex;
        write(
          sex === "m" ? "Отец" : sex === "f" ? "Мать" : "Родитель",
          reference(id),
        );
        const claim = person.parentClaims?.find((item) => item.parentId === id);
        if (claim?.confidence)
          write(
            `Оценка родительства с ${reference(id)}`,
            CLAIM_CONFIDENCE_LABELS[claim.confidence],
          );
        sources(`Источник родительства с ${reference(id)}`, claim?.sources);
      }
      for (const link of [...personLinks.get(person.id)!].sort((a, b) =>
        compareText(a.id, b.id),
      )) {
        write(
          CONNECTION_NAMES[link.type],
          `${reference(link.from)}${link.note ? `; ${inline(link.note)}` : ""}`,
        );
        write(
          "Оценка связи",
          link.confidence && CLAIM_CONFIDENCE_LABELS[link.confidence],
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
        if (!recordedPartners.has(partner))
          writePartner(partner, union.type === "marriage", person.id);
        recordedPartners.add(partner);
        write(
          union.type === "marriage"
            ? "×"
            : union.type === "civil_union"
              ? "Гражданский союз"
              : "Партнёрство",
          [milestone(union.formation), reference(partner)]
            .filter(Boolean)
            .join("; "),
        );
        write(
          "Оценка союза",
          union.confidence && CLAIM_CONFIDENCE_LABELS[union.confidence],
        );
        write(
          "Оценка заключения союза",
          union.formation?.confidence &&
            CLAIM_CONFIDENCE_LABELS[union.formation.confidence],
        );
        write("Развод", milestone(union.divorce));
        write(
          "Оценка развода",
          union.divorce?.confidence &&
            CLAIM_CONFIDENCE_LABELS[union.divorce.confidence],
        );
        write("Завершение союза", milestone(union.ending));
        write(
          "Оценка завершения союза",
          union.ending?.confidence &&
            CLAIM_CONFIDENCE_LABELS[union.ending.confidence],
        );
        write("Союз продолжался", milestone(union.ongoing));
        write(
          "Оценка продолжения союза",
          union.ongoing?.confidence &&
            CLAIM_CONFIDENCE_LABELS[union.ongoing.confidence],
        );
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
        .sort((a, b) => comparePeople(byId.get(a)!, byId.get(b)!))) {
        writePartner(id, false, person.id);
        write("Сведения о союзе", "дата и тип союза не записаны");
      }
      const descendants = children.get(person.id)!.sort(comparePeople);
      if (descendants.length)
        write(
          "Дети",
          descendants
            .map((child, ordinal) => {
              const branch = `${paths.get(person.id)}.${ordinal + 1}`;
              return `${reference(child.id)}${paths.get(child.id) !== branch ? (numbering === "daboville" ? ` (ветвь ${branch}; см. основную запись)` : " (повторная ссылка; см. основную запись)") : ""}`;
            })
            .join("; "),
        );
      writeDetails(person);
      lines.push("");
    }
  }
  return lines.join("\r\n").trimEnd() + "\r\n";
}
