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
) {
  const values = visible ? [JSON.stringify([...visible])] : [];
  const rows = await db
    .prepare(
      `SELECT id,json_extract(data,'$.surname') AS surname,json_extract(data,'$.name') AS name,
      json_extract(data,'$.patronymic') AS patronymic,json_extract(data,'$.death') AS death,
      json_extract(data,'$.deathJulian') AS julian FROM people
      WHERE length(json_extract(data,'$.death'))=10${visible ? " AND id IN (SELECT value FROM json_each(?))" : ""}`,
      `SELECT id,data->>'surname' AS surname,data->>'name' AS name,
      data->>'patronymic' AS patronymic,data->>'death' AS death,data->>'deathJulian' AS julian FROM people
      WHERE length(data->>'death')=10${visible ? " AND id IN (SELECT jsonb_array_elements_text(?::jsonb))" : ""}`,
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
