import { analyzeArchiveWarnings } from "./archive-quality.ts";
import { fullName } from "./dates.ts";
import { familyNeighbors } from "./family-neighborhood.ts";
import { lineageReport } from "./lineage-report.ts";
import type { Family, Person, PersonEvent, Source } from "./types.ts";

export type ArchiveReportKind =
  "person" | "family" | "timeline" | "ancestors" | "descendants" | "research";

export type ArchiveReport = {
  title: string;
  subtitle: string;
  sections: Array<{ heading: string; lines: string[] }>;
};

const known = (value?: string) => value?.trim() || "не указано";
const life = (person: Person) =>
  [person.birth || "?", person.death || (person.deceased ? "?" : "")]
    .filter(Boolean)
    .join(" — ");
const sourceLine = (source: Source) =>
  [source.title, source.reference, source.url, source.note]
    .filter(Boolean)
    .join(" · ");
const eventTitle = (event: PersonEvent) =>
  event.title?.trim() ||
  {
    residence: "Проживание",
    move: "Переезд",
    education: "Образование",
    work: "Работа",
    military: "Военная служба",
    marriage: "Брак",
    divorce: "Развод",
    baptism: "Крещение",
    burial: "Погребение",
    other: "Событие",
  }[event.type];

/** Only the already-authorized family projection is accepted; IDs outside it never appear. */
export function archiveReport(
  family: Family,
  kind: ArchiveReportKind,
  anchorId: string,
  generations = 5,
): ArchiveReport {
  const index = familyNeighbors(family);
  const person = index.people.get(anchorId);
  if (!person) throw new Error("Выберите человека для отчёта.");
  const title = {
    person: "Карточка человека",
    family: "Семейный отчёт",
    timeline: "Хронология жизни",
    ancestors: "Роспись предков",
    descendants: "Роспись потомков",
    research: "Исследовательская сводка",
  }[kind];
  const report: ArchiveReport = {
    title,
    subtitle: fullName(person),
    sections: [],
  };
  const add = (heading: string, lines: string[]) => {
    if (lines.length) report.sections.push({ heading, lines });
  };
  const relatives = (ids: Iterable<string>) =>
    [...new Set(ids)]
      .map((id) => index.people.get(id))
      .filter((item): item is Person => Boolean(item))
      .sort((a, b) => fullName(a).localeCompare(fullName(b), "ru"));
  const personLine = (item: Person) => `${fullName(item)} (${life(item)})`;

  if (kind === "person") {
    add("Основное", [
      `Рождение: ${known(person.birth)}; место: ${known(person.birthPlace)}`,
      `Смерть: ${known(person.death)}; место: ${known(person.deathPlace)}`,
      ...(person.maidenName
        ? [`Фамилия при рождении: ${person.maidenName}`]
        : []),
      ...(person.occupation ? [`Занятие: ${person.occupation}`] : []),
    ]);
    add("Семья", [
      ...relatives(person.parents).map(
        (item) => `Родитель: ${personLine(item)}`,
      ),
      ...relatives(person.spouses).map(
        (item) => `Супруг(а): ${personLine(item)}`,
      ),
      ...relatives(index.children.get(anchorId) || []).map(
        (item) => `Ребёнок: ${personLine(item)}`,
      ),
    ]);
    add("Биография", person.biography ? [person.biography] : []);
    add(
      "Награды",
      (person.awards || []).map((award) =>
        [award.name, award.year, award.source?.title]
          .filter(Boolean)
          .join(" · "),
      ),
    );
  }

  if (kind === "family") {
    add("Выбранный человек", [personLine(person)]);
    for (const [heading, ids] of [
      ["Родители", person.parents],
      ["Партнёры", person.spouses],
      ["Дети", [...(index.children.get(anchorId) || [])]],
    ] as const)
      add(heading, relatives(ids).map(personLine));
    const siblings = new Set<string>();
    for (const parentId of person.parents)
      for (const childId of index.children.get(parentId) || [])
        if (childId !== anchorId) siblings.add(childId);
    add(
      "Братья и сёстры по известным родителям",
      relatives(siblings).map(personLine),
    );
    add(
      "Источники выбранного человека",
      person.sources.map(sourceLine).filter(Boolean),
    );
  }

  if (kind === "timeline" || kind === "person") {
    const events = [
      ...(person.birth
        ? [
            {
              date: person.birth,
              label: person.birth,
              title: "Рождение",
              place: person.birthPlace,
              sources: person.sources,
            },
          ]
        : []),
      ...(person.events || []).map((event) => ({
        date: event.date || "",
        label: event.dateText || event.date || "",
        title: eventTitle(event),
        place: event.place || "",
        sources: event.sources || [],
      })),
      ...(person.death
        ? [
            {
              date: person.death,
              label: person.death,
              title: "Смерть",
              place: person.deathPlace || "",
              sources: person.sources,
            },
          ]
        : []),
    ].sort((a, b) =>
      !a.date ? 1 : !b.date ? -1 : a.date.localeCompare(b.date, "ru"),
    );
    add(
      "События жизни",
      events.flatMap((event) => [
        `${event.label || "Дата не указана"} · ${event.title}${event.place ? ` · ${event.place}` : ""}`,
        ...event.sources.map((source) => `  Источник: ${sourceLine(source)}`),
      ]),
    );
  }

  if (kind === "person")
    add("Источники карточки", person.sources.map(sourceLine).filter(Boolean));

  if (kind === "ancestors" || kind === "descendants") {
    const lines = lineageReport(family, anchorId, kind, generations)
      .trimEnd()
      .split("\n");
    add("По поколениям", lines.slice(1).filter(Boolean));
  }

  if (kind === "research") {
    const depthLimit = Math.max(1, Math.min(20, Math.floor(generations)));
    const ids = new Set<string>();
    const queue = [{ id: anchorId, depth: 0 }];
    for (let position = 0; position < queue.length; position++) {
      const { id, depth } = queue[position];
      if (ids.has(id) || !index.people.has(id)) continue;
      ids.add(id);
      if (depth + 1 < depthLimit)
        for (const parentId of index.people.get(id)!.parents)
          queue.push({ id: parentId, depth: depth + 1 });
    }
    const scope: Family = {
      ...family,
      people: family.people.filter((item) => ids.has(item.id)),
      links: family.links?.filter(
        (link) => ids.has(link.from) && ids.has(link.to),
      ),
    };
    const gaps = scope.people.flatMap((item) => {
      const missing = [
        !item.birth && "дата рождения",
        !item.birthPlace && "место рождения",
        !item.sources.length && "источники карточки",
      ].filter(Boolean);
      return missing.length ? [`${fullName(item)}: ${missing.join(", ")}`] : [];
    });
    add("Объём исследования", [
      `Предки и опорный человек: ${scope.people.length}. Поколений в запросе: ${depthLimit}.`,
      "Отсутствие записи в архиве не доказывает отсутствие события.",
    ]);
    add("Пробелы в записанных сведениях", gaps);
    add(
      "Вычисляемые предупреждения",
      analyzeArchiveWarnings(scope).map(
        (warning) => `${warning.title}: ${warning.detail}`,
      ),
    );
    add(
      "Источники ветки",
      [
        ...new Set(
          scope.people.flatMap((item) => [
            ...item.sources.map(
              (source) => `${fullName(item)}: ${sourceLine(source)}`,
            ),
            ...(item.events || []).flatMap((event) =>
              (event.sources || []).map(
                (source) =>
                  `${fullName(item)} · ${eventTitle(event)}: ${sourceLine(source)}`,
              ),
            ),
          ]),
        ),
      ].filter(Boolean),
    );
  }

  if (!report.sections.length)
    add("Сведения", ["Для этого отчёта пока нет записанных сведений."]);
  return report;
}
