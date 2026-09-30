import { analyzeArchiveWarnings } from "./archive-quality.ts";
import { validatedChanges, type Change } from "./changes.ts";
import { dateBound, fullName } from "./dates.ts";
import type { Family, FamilyLink, Person } from "./types.ts";

export const ADDITIONS_MAX_BYTES = 8 * 1024 * 1024;
export const ADDITIONS_MAX_PEOPLE = 1000;
export type AdditionsPreview = {
  revision: number;
  fingerprint: string;
  people: { id: string; name: string; birth: string; death?: string }[];
  connections: number;
  detachedPeople: number;
  warnings: string[];
  warningCount: number;
  errors: string[];
  errorCount: number;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Ожидается объект JSON");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`Поле «${key}» не поддерживается пакетным добавлением`);
}
function id(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error(
      "У каждой новой карточки и связи должен быть постоянный id",
    );
  return value;
}

/** Builds only insertions. Never accepts updates, a replacement archive or media. */
export function planAdditions(
  current: Family,
  input: unknown,
  actorId: string,
) {
  const data = object(input);
  if (data.format !== "drevo.reviewed-add-only" || data.version !== 1)
    throw new Error(
      "Нужен пакет drevo.reviewed-add-only версии 1, а не полный экспорт архива",
    );
  fields(data, [
    "format",
    "version",
    "newPeople",
    "newLinks",
    "existingPeople",
    "status",
    "baseExportRevision",
    "baseExportSha256",
    "sourceFile",
    "applicationNote",
    "omittedExistingConnection",
  ]);
  if (
    data.existingPeople !== undefined &&
    (!Array.isArray(data.existingPeople) || data.existingPeople.length)
  )
    throw new Error(
      "Изменения существующих карточек запрещены. existingPeople должен быть пустым",
    );
  if (
    !Array.isArray(data.newPeople) ||
    !data.newPeople.length ||
    data.newPeople.length > ADDITIONS_MAX_PEOPLE
  )
    throw new Error(
      `Допустимо от 1 до ${ADDITIONS_MAX_PEOPLE} новых карточек за один импорт`,
    );
  if (
    data.newLinks !== undefined &&
    (!Array.isArray(data.newLinks) || data.newLinks.length > 3000)
  )
    throw new Error("Допустимо не более 3000 дополнительных связей");
  const oldIds = new Set(current.people.map((p) => p.id));
  const newIds = new Set<string>();
  const people = data.newPeople.map((raw): Person => {
    const p = object(raw);
    fields(p, [
      "id",
      "surname",
      "name",
      "patronymic",
      "sex",
      "birth",
      "death",
      "deceased",
      "needsReview",
      "birthPlace",
      "deathPlace",
      "birthLocation",
      "deathLocation",
      "maidenName",
      "occupation",
      "biography",
      "awards",
      "events",
      "parents",
      "parentageComplete",
      "spouses",
      "generation",
      "column",
      "sources",
    ]);
    const personId = id(p.id);
    if (typeof p.name !== "string" || typeof p.surname !== "string")
      throw new Error("У новой карточки должны быть имя и фамилия");
    if (oldIds.has(personId))
      throw new Error(
        `Карточка ${personId} уже существует. Повторное добавление и изменение запрещены`,
      );
    if (newIds.has(personId))
      throw new Error(`Повторяющийся id карточки: ${personId}`);
    newIds.add(personId);
    return {
      patronymic: "",
      sex: "u",
      birth: "",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      ...structuredClone(p),
      name: p.name,
      surname: p.surname,
      id: personId,
      generation: 1,
      column: 0,
      createdBy: actorId,
      needsReview: true,
    } as Person;
  });
  const oldLinks = new Set((current.links || []).map((l) => l.id));
  const linkIds = new Set<string>();
  const links = ((data.newLinks || []) as unknown[]).map((raw): FamilyLink => {
    const link = object(raw);
    fields(link, ["id", "from", "to", "type", "note", "twinKind"]);
    const linkId = id(link.id);
    if (oldLinks.has(linkId) || linkIds.has(linkId))
      throw new Error(`Связь ${linkId} уже существует или повторяется`);
    linkIds.add(linkId);
    if (!newIds.has(String(link.from)) || !newIds.has(String(link.to)))
      throw new Error(
        "Дополнительные связи в пакете допускаются только между новыми карточками",
      );
    return {
      ...structuredClone(link),
      id: linkId,
      createdBy: actorId,
    } as FamilyLink;
  });
  const changes: Change[] = [
    ...people.map((p): Change => ({
      collection: "people",
      id: p.id,
      before: undefined,
      after: p,
    })),
    ...links.map((l): Change => ({
      collection: "links",
      id: l.id,
      before: undefined,
      after: l,
    })),
  ];
  const { family, conflicts } = validatedChanges(current, changes);
  if (conflicts.length) throw new Error("Пакет конфликтует с текущим архивом");
  const byId = new Map(family.people.map((p) => [p.id, p]));
  const errors: string[] = [];
  const warnings = analyzeArchiveWarnings(family).filter((w) =>
    w.personIds.some((i) => newIds.has(i)),
  );
  const blocking = new Set([
    "young-parent",
    "old-parent",
    "late-after-parent-death",
    "many-blood-parents",
    "parent-and-spouse",
    "blood-and-step-parent",
  ]);
  for (const w of warnings)
    if (w.level === "error" || blocking.has(w.code))
      errors.push(`${w.title}: ${w.detail}`);
  for (const p of people) {
    for (const sid of p.spouses) {
      if (!newIds.has(sid) || !byId.get(sid)!.spouses.includes(p.id))
        errors.push(
          `${fullName(p)}: супруги должны быть новыми карточками с взаимной связью. Существующая карточка не будет изменена.`,
        );
      const spouse = byId.get(sid)!;
      if (
        p.birth &&
        spouse.death &&
        dateBound(p.birth, false) > dateBound(spouse.death, true)
      )
        errors.push(`${fullName(p)}: супруг умер до рождения этого человека.`);
    }
    for (const pid of p.parents) {
      const parent = byId.get(pid)!;
      if (
        parent.sex === "f" &&
        parent.death &&
        p.birth &&
        dateBound(p.birth, false) > dateBound(parent.death, true)
      )
        errors.push(`${fullName(p)}: рождение после смерти указанной матери.`);
    }
    for (const event of p.events || []) {
      if (event.type !== "marriage" || !event.date) continue;
      if (p.death && dateBound(event.date, false) > dateBound(p.death, true))
        errors.push(
          `${fullName(p)}: брак ${event.date} после смерти ${p.death}.`,
        );
      // Events have no spouse ID. Only an unambiguous single spouse can be checked.
      const spouse =
        p.spouses.length === 1 ? byId.get(p.spouses[0]) : undefined;
      if (
        spouse?.death &&
        dateBound(event.date, false) > dateBound(spouse.death, true)
      )
        errors.push(
          `${fullName(p)}: брак ${event.date} после смерти супруга ${spouse.death}.`,
        );
    }
  }
  // Count islands explicitly; no invented links to old cards to make the graph connected.
  const adjacency = new Map(
    family.people.map((p) => [p.id, new Set<string>()]),
  );
  for (const p of family.people)
    for (const other of [...p.parents, ...p.spouses]) {
      adjacency.get(p.id)!.add(other);
      adjacency.get(other)!.add(p.id);
    }
  for (const link of family.links || []) {
    adjacency.get(link.from)!.add(link.to);
    adjacency.get(link.to)!.add(link.from);
  }
  const reached = new Set(oldIds),
    queue = [...oldIds];
  while (queue.length)
    for (const other of adjacency.get(queue.pop()!)!)
      if (!reached.has(other)) {
        reached.add(other);
        queue.push(other);
      }
  const detachedPeople = people.filter((p) => !reached.has(p.id)).length;
  const messages = warnings
    .filter((w) => w.level !== "error" && !blocking.has(w.code))
    .map((w) => `${w.title}: ${w.detail}`);
  const uniqueErrors = [...new Set(errors)];
  return {
    family,
    changes,
    preview: {
      people: people.map((p) => ({
        id: p.id,
        name: fullName(p),
        birth: p.birth,
        ...(p.death ? { death: p.death } : {}),
      })),
      connections: people.reduce(
        (n, p) => n + p.parents.length + p.spouses.length / 2,
        links.length,
      ),
      detachedPeople,
      warnings: messages.slice(0, 100),
      warningCount: messages.length,
      errors: uniqueErrors.slice(0, 100),
      errorCount: uniqueErrors.length,
    },
  };
}
