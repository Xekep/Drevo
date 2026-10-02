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
  const seen = new Set<string>();

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
    if (seen.has(key)) return;
    seen.add(key);
    result.push(clean);
  };

  for (const source of person.sources || []) add(source);

  for (const source of person.occupationClaim?.sources || [])
    add(source, "Занятие");
  for (const source of person.maidenNameClaim?.sources || [])
    add(source, "Фамилия при рождении");

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
    for (const source of event.sources || []) {
      const label = event.title?.trim() || event.type;
      add(source, `Событие: ${label}`);
    }
  }

  return result;
}
