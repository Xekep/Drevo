import type { PersonEvent } from "./types.ts";
import { validDate, dateBound, safeUrl } from "./dates.ts";
export const EVENT_NAMES: Record<PersonEvent["type"], string> = {
  residence: "Проживание",
  move: "Переезд",
  education: "Учёба",
  work: "Работа",
  military: "Военная служба",
  marriage: "Брак",
  divorce: "Развод",
  baptism: "Крещение",
  burial: "Захоронение",
  other: "Другое событие",
};
export function validateEvents(events: unknown): void {
  if (events === undefined) return;
  if (!Array.isArray(events) || events.length > 200)
    throw new Error("Допустимо не более 200 событий у человека");
  const ids = new Set<string>();
  for (const e of events as PersonEvent[]) {
    if (
      !e ||
      typeof e.id !== "string" ||
      !e.id ||
      e.id.length > 100 ||
      ids.has(e.id) ||
      !Object.hasOwn(EVENT_NAMES, e.type)
    )
      throw new Error("Некорректное событие человека");
    ids.add(e.id);
    for (const key of ["title", "dateText", "place", "description"] as const)
      if (
        e[key] !== undefined &&
        (typeof e[key] !== "string" ||
          e[key].length > (key === "description" ? 10000 : 1000))
      )
        throw new Error("Проверьте описание события");
    for (const value of [e.date, e.endDate])
      if (
        value !== undefined &&
        (!validDate(value) || value > new Date().toISOString().slice(0, 10))
      )
        throw new Error("Проверьте дату события");
    if (
      e.date &&
      e.endDate &&
      dateBound(e.endDate, true) < dateBound(e.date, false)
    )
      throw new Error("Конец периода раньше его начала");
    const location = e.location;
    if (
      location !== undefined &&
      (!location ||
        typeof location.place !== "string" ||
        !location.place.trim() ||
        location.place.length > 1000 ||
        !Number.isFinite(location.lat) ||
        !Number.isFinite(location.lon) ||
        Math.abs(location.lat) > 90 ||
        Math.abs(location.lon) > 180 ||
        (location.label !== undefined &&
          (typeof location.label !== "string" || location.label.length > 1000)))
    )
      throw new Error("Проверьте точку события на карте");
    if (e.sources !== undefined) {
      if (!Array.isArray(e.sources) || e.sources.length > 50)
        throw new Error("Слишком много источников события");
      for (const s of e.sources)
        if (
          !s ||
          ![s.title, s.type, s.reference].every(
            (v) => typeof v === "string" && v.length <= 5000,
          ) ||
          (s.note !== undefined &&
            (typeof s.note !== "string" || s.note.length > 10000)) ||
          (s.url !== undefined &&
            (typeof s.url !== "string" ||
              !/^https?:\/\//i.test(s.url) ||
              !safeUrl(s.url)))
        )
          throw new Error("Проверьте источник события");
    }
  }
}
