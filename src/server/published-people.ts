import type { Person } from "../domain/types.ts";
import { fullName } from "../domain/dates.ts";
import type { StoreDatabase } from "./store-database.ts";

export type PublicPerson = {
  id: string;
  name: string;
  birthYear?: string;
  deathYear?: string;
  birthPlace?: string;
  deathPlace?: string;
};

export const publishablePerson = (person: Person) =>
  person.deceased === true || Boolean(person.death);

const year = (value?: string) => value?.match(/\b\d{4}\b/)?.[0];

/** Deliberately project only the fields approved for public discovery. */
export function publicPerson(person: Person): PublicPerson {
  return {
    id: person.id,
    name: fullName(person),
    ...(year(person.birth) ? { birthYear: year(person.birth) } : {}),
    ...(year(person.death) ? { deathYear: year(person.death) } : {}),
    ...(person.birthPlace ? { birthPlace: person.birthPlace } : {}),
    ...(person.deathPlace ? { deathPlace: person.deathPlace } : {}),
  };
}

export function publishedPeopleStore(db: StoreDatabase) {
  return {
    async ids() {
      const rows = await db
        .prepare("SELECT person_id FROM published_people")
        .all();
      return new Set(rows.map((row) => String(row.person_id)));
    },
    async has(personId: string) {
      return Boolean(
        await db
          .prepare(
            "SELECT 1 AS present FROM published_people WHERE person_id=?",
          )
          .get(personId),
      );
    },
    async publish(personId: string, actorId: string) {
      await db
        .prepare(
          "INSERT OR IGNORE INTO published_people(person_id,published_at,published_by) VALUES(?,?,?)",
          "INSERT INTO published_people(person_id,published_at,published_by) VALUES(?,?,?) ON CONFLICT(archive_id,person_id) DO NOTHING",
        )
        .run(personId, new Date().toISOString(), actorId);
    },
    async unpublish(personId: string) {
      await db
        .prepare("DELETE FROM published_people WHERE person_id=?")
        .run(personId);
    },
  };
}
