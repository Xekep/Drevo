import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./postgres-fixture.ts";

const migration = readFileSync(
  new URL("../../ops/postgres/014_family_indexed_fields.sql", import.meta.url),
  "utf8",
);

test("indexed family fields follow JSON edits without changing archive data", async (t) => {
  const { first } = await fixture(t);
  await first.query(migration);
  await first.query(migration);

  await first.query(
    `UPDATE people SET data=data || '{"surname":"Ёжов","maidenName":"Берёзина","name":"Алёна","birth":"1881","birthPlace":"Орёл"}'::jsonb
      WHERE archive_id='tree-a' AND id='child'`,
  );
  await first.query(
    `UPDATE photos SET data=data || '{"title":"Семья в Орле","place":"Орёл","takenAt":"1901"}'::jsonb
      WHERE archive_id='tree-a' AND id='photo'`,
  );

  const person = (
    await first.query(
      `SELECT surname_search,maiden_name_search,given_name_search,birth_text,birth_place_search,data
         FROM people WHERE archive_id='tree-a' AND id='child'`,
    )
  ).rows[0];
  assert.deepEqual(
    [
      person.surname_search,
      person.maiden_name_search,
      person.given_name_search,
      person.birth_text,
      person.birth_place_search,
    ],
    ["ежов", "березина", "алена", "1881", "орел"],
  );
  assert.equal(person.data.surname, "Ёжов");
  assert.equal(person.data.birth, "1881");

  const photo = (
    await first.query(
      "SELECT title_search,place_search,taken_at_text FROM photos WHERE archive_id='tree-a' AND id='photo'",
    )
  ).rows[0];
  assert.deepEqual(photo, {
    title_search: "семья в орле",
    place_search: "орел",
    taken_at_text: "1901",
  });

  const otherArchive = (
    await first.query(
      "SELECT surname_search FROM people WHERE archive_id='tree-b' AND id='child'",
    )
  ).rows[0];
  assert.equal(otherArchive.surname_search, "тест");

  const indexes = (
    await first.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()
        AND indexname=ANY($1::text[])`,
      [
        [
          "people_surname_name_search",
          "people_maiden_name_search",
          "people_birth_lookup",
          "people_birth_place_search",
          "photos_title_search",
          "photos_place_search",
          "photos_taken_at_lookup",
          "documents_title_search",
        ],
      ],
    )
  ).rows;
  assert.equal(indexes.length, 8);
});
