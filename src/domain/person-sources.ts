import type { Person, Source } from "./types.ts";

export type PersonSourceEntry = Source & {
  origin?: string;
};

function normalized(value?: string) {
  return (value || "").trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
}

function sourceKey(source: Source) {
  const url = normalized(source.url);
  if (url) return `url:${url}`;
  return `text:${normalized(source.title)}|${normalized(source.reference)}`;
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
      origin,
    };
    const key = sourceKey(clean);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(clean);
  };

  for (const source of person.sources || []) add(source);

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
    for (const source of event.sources || []) {
      const label = event.title?.trim() || event.type;
      add(source, `Событие: ${label}`);
    }
  }

  return result;
}
