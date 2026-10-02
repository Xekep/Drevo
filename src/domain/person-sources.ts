import type { Person, Source } from "./types.ts";

export type PersonSourceEntry = Source & {
  origin?: string;
};

export function repositorySummary(source: Source): string {
  const repository = source.repository;
  if (!repository) return "";
  return [
    `Хранилище: ${repository.name}`,
    repository.callNumber && `Шифр: ${repository.callNumber}`,
    repository.website && `Сайт: ${repository.website}`,
    repository.note && `Примечание хранилища: ${repository.note}`,
    repository.linkNote && `Примечание о хранении: ${repository.linkNote}`,
  ].filter(Boolean).join(" · ");
}

function normalized(value?: string) {
  return (value || "").trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
}

function sourceKey(source: Source) {
  const repository = source.repository ? `|repository:${JSON.stringify(source.repository)}` : "";
  if (source.documentId)
    return `document:${source.documentId}:${source.documentPage || 1}${repository}`;
  const url = normalized(source.url);
  if (url) return `url:${url}${repository}`;
  return `text:${normalized(source.title)}|${normalized(source.reference)}${repository}`;
}

/**
 * Собирает источники человека из основной карточки и вложенных сущностей.
 * Вкладка «Источники» должна быть сводной, а не заставлять искать ссылку
 * внутри конкретной награды или события.
 */
export function collectPersonSources(person: Person): PersonSourceEntry[] {
  const result: PersonSourceEntry[] = [];
  const seen = new Map<string, number>();

  const add = (source: Source, origin?: string) => {
    const clean: PersonSourceEntry = {
      ...source,
      title: source.title.trim(),
      type: source.type.trim(),
      reference: source.reference.trim(),
      url: source.url?.trim() || undefined,
      note: source.note?.trim() || undefined,
      documentId: source.documentId,
      origin,
    };
    const key = sourceKey(clean);
    const existing = seen.get(key);
    if (existing !== undefined) {
      if (origin && !result[existing].origin?.split("; ").includes(origin))
        result[existing].origin = [result[existing].origin, origin].filter(Boolean).join("; ");
      return;
    }
    seen.set(key, result.length);
    result.push(clean);
  };

  for (const source of person.sources || []) add(source);

  for (const source of person.occupationClaim?.sources || [])
    add(source, "Занятие");
  for (const source of person.maidenNameClaim?.sources || [])
    add(source, "Фамилия при рождении");
  for (const [label, claim] of [
    ["Дата рождения", person.birthDateClaim],
    ["Дата смерти", person.deathDateClaim],
    ["Место рождения", person.birthPlaceClaim],
    ["Место смерти", person.deathPlaceClaim],
  ] as const)
    for (const source of claim?.sources || []) add(source, label);
  const alternativeName = {
    birth: "Другая дата рождения", death: "Другая дата смерти",
    birthPlace: "Другое место рождения", deathPlace: "Другое место смерти",
    maidenName: "Другая фамилия при рождении",
  } as const;
  for (const alternative of person.factAlternatives || [])
    for (const source of alternative.sources)
      add(source, `${alternativeName[alternative.field]}: ${alternative.value}`);

  for (const award of person.awards || []) {
    const source = award.source;
    if (!source?.title?.trim() && !source?.url?.trim()) continue;
    add(
      {
        title: source.title?.trim() || award.name,
        type: "Награда",
        reference: [award.name, award.year].filter(Boolean).join(" · "),
        url: source.url,
      },
      "Источник награды",
    );
  }

  for (const event of person.events || []) {
    for (const source of event.dateClaim?.sources || [])
      add(source, `Дата события: ${event.title?.trim() || event.type}`);
    for (const source of event.placeClaim?.sources || [])
      add(source, `Место события: ${event.title?.trim() || event.type}`);
    for (const alternative of event.alternatives || [])
      for (const source of alternative.sources)
        add(source, `${alternative.field === "date" ? "Другая дата" : "Другое место"} события: ${alternative.value}`);
    for (const source of event.sources || []) {
      const label = event.title?.trim() || event.type;
      add(source, `Событие: ${label}`);
    }
  }

  return result;
}
