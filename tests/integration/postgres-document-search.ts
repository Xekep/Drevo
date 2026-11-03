import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./postgres-fixture.ts";
import {
  documentSearchQuery,
  documentSearchPeople,
  normalizeDocumentQuery,
} from "../../src/server/document-search-query.ts";
import { postgresBindings } from "../../src/server/store-database.ts";
import { documentSearchText } from "../../src/shared/document-details.ts";
import {
  rankedSearchIds,
  searchDocuments,
  searchPeople,
} from "../fixtures/document-search.ts";

test("PostgreSQL document relevance and all-word filtering precede pagination", async (t) => {
  const { first } = await fixture(t);
  await first.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  for (const [index, person] of searchPeople.entries())
    await first.query(
      "INSERT INTO people(archive_id,id,ordinal,data) VALUES('tree-a',$1,$2,$3::jsonb)",
      [person.id, 100 + index, JSON.stringify(person)],
    );
  let association = 0;
  for (const [index, document] of searchDocuments.entries()) {
    const text = documentSearchText(document.title, {
      documentType: "",
      documentDate: "",
      place: "",
      description: document.description,
      provenance: "",
    });
    await first.query(
      "INSERT INTO documents(archive_id,id,ordinal,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES('tree-a',$1,$2,$3,$4,$5,1,'admin',$6)",
      [
        document.id,
        index,
        document.title,
        text,
        `${document.id}.pdf`,
        document.createdAt,
      ],
    );
    for (const id of document.people)
      await first.query(
        "INSERT INTO document_people(archive_id,ordinal,document_id,person_id) VALUES('tree-a',$1,$2,$3)",
        [association++, document.id, id],
      );
  }
  const linkedNames = await documentSearchPeople({
    prepare(_sqlite, postgres) {
      assert.ok(postgres);
      return {
        async all(...args) {
          const result = await first.query(postgresBindings(postgres), args);
          for (const row of result.rows)
            assert.deepEqual(Object.keys(row).sort(), ["id", "name", "patronymic", "surname"],
              "PostgreSQL name search must not transfer complete person JSON");
          return result.rows;
        },
        async get() { throw new Error("Unexpected single-row lookup"); },
        async run() { throw new Error("Name search must not write"); },
      };
    },
  });
  const linkedIds = new Set(searchDocuments.flatMap(document => document.people));
  assert.deepEqual(linkedNames.toSorted((a, b) => a.id.localeCompare(b.id)),
    searchPeople.filter(person => linkedIds.has(person.id))
      .map(({ id, name, surname, patronymic }) => ({ id, name, surname, patronymic }))
      .toSorted((a, b) => a.id.localeCompare(b.id)));
  const search = async (
    query: string,
    offset = 0,
    limit = 100,
    people = searchPeople,
  ) => {
    const spec = documentSearchQuery(
      normalizeDocumentQuery(query),
      people,
      "postgres",
    );
    const where = `d.archive_id='tree-a' AND ${spec.condition}`;
    const count = await first.query(
      postgresBindings(
        `SELECT count(*)::integer AS total FROM documents d WHERE ${where}`,
      ),
      spec.args,
    );
    const result = await first.query(
      postgresBindings(
        `SELECT d.id FROM documents d WHERE ${where} ORDER BY ${spec.order},d.created_at DESC,d.id DESC LIMIT ? OFFSET ?`,
      ),
      [...spec.args, ...spec.orderArgs, limit, offset],
    );
    return {
      total: count.rows[0].total,
      ids: result.rows.map((row) => row.id),
    };
  };
  assert.deepEqual(await search("  ЧЕПЧУГОВ  Павел  "), {
    total: 5,
    ids: rankedSearchIds,
  });
  assert.deepEqual(await search("чепчугов павел", 0, 2), {
    total: 5,
    ids: rankedSearchIds.slice(0, 2),
  });
  assert.deepEqual(await search("чепчугов павел", 2, 3), {
    total: 5,
    ids: rankedSearchIds.slice(2),
  });
  assert.equal((await search("павел чепчугов")).ids[0], "exact-person");
  assert.deepEqual((await search("чепчугов семен")).ids, [
    "yo-title",
    "yo-person",
  ]);
  assert.deepEqual((await search("Чепчугов Семён")).ids, [
    "yo-title",
    "yo-person",
  ]);
  assert.deepEqual(
    (await search("чепчугов павел", 0, 100, [])).ids,
    ["exact-title", "title-words", "metadata"],
    "names outside the visible people projection must not contribute to matches or relevance",
  );
  assert.equal((await search("%' OR 1=1 --")).total, 0);
});
