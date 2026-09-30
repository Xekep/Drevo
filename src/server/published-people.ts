import type { Person } from "../domain/types.ts";
import { fullName } from "../domain/dates.ts";
import type { StoreDatabase } from "./store-database.ts";
import { defaultPublicationFields, type PublicationFields } from "../shared/publication.ts";

export type PublicPerson = {
  id: string;
  name: string;
  birthSurname?: string;
  birthYear?: string;
  deathYear?: string;
  birthPlace?: string;
  deathPlace?: string;
};

function fieldsFromRow(row: Record<string, unknown>): PublicationFields {
  return {
    birthSurname: row.birth_surname_visible === true || row.birth_surname_visible === 1,
    birthYear: row.birth_year_visible === true || row.birth_year_visible === 1,
    deathYear: row.death_year_visible === true || row.death_year_visible === 1,
    birthPlace: row.birth_place_visible === true || row.birth_place_visible === 1,
    deathPlace: row.death_place_visible === true || row.death_place_visible === 1,
  };
}

export const publishablePerson = (person: Person) =>
  person.deceased === true || Boolean(person.death);

const year = (value?: string) => value?.match(/\b\d{4}\b/)?.[0];

/** Deliberately project only the fields approved for public discovery. */
export function publicPerson(person: Person, fields: PublicationFields = defaultPublicationFields): PublicPerson {
  return {
    id: person.id,
    name: fullName(person),
    ...(fields.birthSurname && person.maidenName ? { birthSurname: person.maidenName } : {}),
    ...(fields.birthYear && year(person.birth) ? { birthYear: year(person.birth) } : {}),
    ...(fields.deathYear && year(person.death) ? { deathYear: year(person.death) } : {}),
    ...(fields.birthPlace && person.birthPlace ? { birthPlace: person.birthPlace } : {}),
    ...(fields.deathPlace && person.deathPlace ? { deathPlace: person.deathPlace } : {}),
  };
}

export function publishedPeopleStore(db: StoreDatabase) {
  return {
    async entries() {
      const rows = await db
        .prepare(
          "SELECT person_id,birth_surname_visible,birth_year_visible,death_year_visible,birth_place_visible,death_place_visible FROM published_people",
          "SELECT person_id,birth_surname_visible,birth_year_visible,death_year_visible,birth_place_visible,death_place_visible FROM published_people",
        )
        .all();
      return new Map(rows.map((row) => [String(row.person_id), fieldsFromRow(row)]));
    },
    async getFields(personId: string) {
      const row = await db.prepare(
        "SELECT birth_surname_visible,birth_year_visible,death_year_visible,birth_place_visible,death_place_visible FROM published_people WHERE person_id=?",
        "SELECT birth_surname_visible,birth_year_visible,death_year_visible,birth_place_visible,death_place_visible FROM published_people WHERE person_id=?",
      ).get(personId);
      return row ? fieldsFromRow(row) : null;
    },
    async publish(personId: string, actorId: string, fields: PublicationFields = defaultPublicationFields) {
      await db
        .prepare(
          `INSERT INTO published_people(person_id,published_at,published_by,birth_surname_visible,birth_year_visible,death_year_visible,birth_place_visible,death_place_visible)
           VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(person_id) DO UPDATE SET
           published_at=excluded.published_at,published_by=excluded.published_by,
           birth_surname_visible=excluded.birth_surname_visible,birth_year_visible=excluded.birth_year_visible,
           death_year_visible=excluded.death_year_visible,birth_place_visible=excluded.birth_place_visible,
           death_place_visible=excluded.death_place_visible`,
          `INSERT INTO published_people(person_id,published_at,published_by,birth_surname_visible,birth_year_visible,death_year_visible,birth_place_visible,death_place_visible)
           VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(archive_id,person_id) DO UPDATE SET
           published_at=excluded.published_at,published_by=excluded.published_by,
           birth_surname_visible=excluded.birth_surname_visible,birth_year_visible=excluded.birth_year_visible,
           death_year_visible=excluded.death_year_visible,birth_place_visible=excluded.birth_place_visible,
           death_place_visible=excluded.death_place_visible`,
        )
        .run(personId, new Date().toISOString(), actorId,
          Number(fields.birthSurname),Number(fields.birthYear),Number(fields.deathYear),
          Number(fields.birthPlace),Number(fields.deathPlace));
    },
    async unpublish(personId: string) {
      await db
        .prepare(
          "DELETE FROM published_people WHERE person_id=?",
          "DELETE FROM published_people WHERE person_id=?",
        )
        .run(personId);
    },
  };
}
