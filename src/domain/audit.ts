import { archiveChanges, type Change } from "./changes.ts";
import { fullName } from "./dates.ts";
import type { Family } from "./types.ts";
import { EVENT_NAMES } from "./person-events.ts";

export type AuditDetail = { field: string; before: string; after: string };
export type AuditEntry = {
  id: number;
  at: string;
  actorId: string;
  actorName: string;
  action: string;
  entity: string;
  entityId: string;
  label: string;
  revision: number | null;
  details: AuditDetail[];
};
export type AuditDraft = Omit<
  AuditEntry,
  "id" | "at" | "actorId" | "actorName" | "revision"
> & { personIds: string[] };
const fields: Record<string, string> = {
  surname: "Фамилия",
  name: "Имя",
  patronymic: "Отчество",
  sex: "Пол",
  birth: "Дата рождения",
  death: "Дата смерти",
  birthPlace: "Место рождения",
  deathPlace: "Место смерти",
  birthLocation: "Точка рождения",
  deathLocation: "Точка смерти",
  maidenName: "Фамилия при рождении",
  occupation: "Занятие",
  biography: "Биография",
  awards: "Награды",
  photo: "Портрет",
  parents: "Родители",
  spouses: "Супруги",
  parentageComplete: "Все родители известны",
  sources: "Источники",
  title: "Название",
  description: "Описание",
  type: "Тип",
  from: "Первый участник",
  to: "Второй участник",
  note: "Примечание",
  tags: "Отметки людей",
  year: "Год",
  place: "Место",
  event: "Событие",
  takenAt: "Дата или период",
  url: "Файл или ссылка",
  reference: "Архивный шифр",
  personId: "Человек",
  x: "X",
  y: "Y",
  width: "Ширина",
  height: "Высота",
  source: "Источник",
  lat: "Широта",
  lon: "Долгота",
  label: "Место",
  events: "События жизни",
  date: "Дата",
  endDate: "Конец периода",
  dateText: "Исходная дата",
  deceased: "Известно, что человек умер",
  location: "Точка на карте",
};
const hidden = new Set([
  "id",
  "createdBy",
  "createdAt",
  "generation",
  "column",
  "demo",
]);
function describe(
  value: unknown,
  field: string,
  names: Map<string, string>,
): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (field === "photo") return "Портрет указан";
  if (typeof value === "string") {
    if (["parents", "spouses", "from", "to", "personId"].includes(field))
      return names.get(value) || "Удалённый человек";
    if (field === "sex")
      return { m: "Мужской", f: "Женский", u: "Не указан" }[value] || value;
    if (field === "type" && Object.hasOwn(EVENT_NAMES, value))
      return EVENT_NAMES[value as keyof typeof EVENT_NAMES];
    return value;
  }
  if (Array.isArray(value))
    return value
      .map((v) => describe(v, field, names))
      .filter(Boolean)
      .join("\n");
  if (typeof value === "object")
    return Object.entries(value)
      .filter(([key]) => !hidden.has(key))
      .map(([key, v]) => {
        const text = describe(v, key, names);
        return text ? `${fields[key] || key}: ${text}` : "";
      })
      .filter(Boolean)
      .join("; ");
  return String(value);
}

/** Журнал строится из сохранённых значений, без предположений о старых авторах. */
export function archiveAudit(before: Family, after: Family): AuditDraft[] {
  const names = new Map(
    [...before.people, ...after.people].map((p) => [p.id, fullName(p)]),
  );
  const groups = new Map<string, Change[]>();
  for (const change of archiveChanges(before, after)) {
    if (change.field && hidden.has(change.field)) continue;
    const key = `${change.collection}:${change.id || "archive"}`;
    groups.set(key, [...(groups.get(key) || []), change]);
  }
  return [...groups.values()].map((changes) => {
    const first = changes[0],
      id = first.id || "archive";
    const action = !first.field
      ? first.before === undefined
        ? "Добавлено"
        : "Удалено"
      : "Изменено";
    const personIds = new Set<string>();
    if (first.collection === "people") personIds.add(id);
    for (const family of [before, after]) {
      if (first.collection === "links") {
        const link = family.links?.find((l) => l.id === id);
        if (link) {
          personIds.add(link.from);
          personIds.add(link.to);
        }
      }
      if (first.collection === "photos")
        for (const tag of family.photos?.find((p) => p.id === id)?.tags || [])
          personIds.add(tag.personId);
    }
    for (const c of changes) {
      if (c.collection !== "people") continue;
      for (const value of [c.before, c.after]) {
        if (c.field === "parents" || c.field === "spouses")
          for (const related of (value as string[] | undefined) || [])
            personIds.add(related);
        if (!c.field && value) {
          const p = value as Family["people"][number];
          for (const related of [...p.parents, ...p.spouses])
            personIds.add(related);
        }
      }
    }
    const link =
      after.links?.find((l) => l.id === id) ||
      before.links?.find((l) => l.id === id);
    const label =
      first.collection === "people"
        ? names.get(id) || "Человек"
        : first.collection === "links" && link
          ? `${names.get(link.from)} — ${names.get(link.to)}`
          : first.collection === "photos"
            ? "Фотография"
            : "Семейный архив";
    return {
      action,
      entity: first.collection,
      entityId: id,
      label,
      personIds: [...personIds],
      details: changes.flatMap((c) => {
        if (c.field)
          return [
            {
              field: fields[c.field] || c.field,
              before:
                c.field === "photo" && c.before
                  ? "Предыдущий портрет"
                  : describe(c.before, c.field, names),
              after:
                c.field === "photo" && c.after
                  ? "Новый портрет"
                  : describe(c.after, c.field, names),
            },
          ];
        const record = (c.after || c.before) as Record<string, unknown>;
        return Object.entries(record)
          .filter(([key]) => !hidden.has(key))
          .map(([key, value]) => ({
            field: fields[key] || key,
            before: c.before ? describe(value, key, names) : "",
            after: c.after ? describe(value, key, names) : "",
          }))
          .filter((d) => d.before || d.after);
      }),
    };
  });
}
