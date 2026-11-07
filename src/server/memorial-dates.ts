import {
  upcomingMemorialDates,
  type MemorialPerson,
} from "../domain/memorial-dates.ts";
import type { StoreDatabase } from "./store-database.ts";

/** Read only life dates and names, with the current access scope inside SQL. */
export async function readMemorialDates(
  db: StoreDatabase,
  visible: ReadonlySet<string> | null,
  today: string,
  includeBirthdays = false,
) {
  const values = visible ? [JSON.stringify([...visible])] : [];
  const rows = await db
    .prepare(
      `SELECT id,json_extract(data,'$.surname') AS surname,json_extract(data,'$.name') AS name,
      json_extract(data,'$.patronymic') AS patronymic,json_extract(data,'$.death') AS death,
      json_extract(data,'$.deathJulian') AS julian,json_extract(data,'$.birth') AS birth,
      json_extract(data,'$.birthJulian') AS birth_julian,json_extract(data,'$.deceased') AS deceased,
      json_extract(data,'$.deathPlace') AS death_place FROM people
      WHERE (length(json_extract(data,'$.death'))=10${includeBirthdays ? " OR length(json_extract(data,'$.birth'))=10" : ""})${visible ? " AND id IN (SELECT value FROM json_each(?))" : ""}`,
      `SELECT id,data->>'surname' AS surname,data->>'name' AS name,
      data->>'patronymic' AS patronymic,data->>'death' AS death,data->>'deathJulian' AS julian,data->>'birth' AS birth,
      data->>'birthJulian' AS birth_julian,data->>'deceased' AS deceased,data->>'deathPlace' AS death_place FROM people
      WHERE (length(data->>'death')=10${includeBirthdays ? " OR length(data->>'birth')=10" : ""})${visible ? " AND id IN (SELECT jsonb_array_elements_text(?::jsonb))" : ""}`,
    )
    .all(...values);
  return upcomingMemorialDates(
    rows.map((row): MemorialPerson => ({
      id: String(row.id),
      surname: String(row.surname || ""),
      name: String(row.name || ""),
      patronymic: String(row.patronymic || ""),
      death: String(row.death || ""),
      deathJulian: row.julian ? String(row.julian) : undefined,
      birth: String(row.birth || ""),
      birthJulian: row.birth_julian ? String(row.birth_julian) : undefined,
      deceased:
        row.deceased === true || row.deceased === 1 || row.deceased === "true",
      deathPlace: String(row.death_place || ""),
    })),
    today,
  );
}

export function memorialToday(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
