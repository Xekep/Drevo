import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { documentSearchText } from "../src/shared/document-details.ts";
import { documentSearchPeople } from "../src/server/document-search-query.ts";
import { storeDatabase } from "../src/server/store-database.ts";
import {
  rankedSearchIds,
  searchDocuments,
  searchPeople,
} from "./fixtures/document-search.ts";

test("document name search transfers only name fields from linked cards", async () => {
  const source = new DatabaseSync(":memory:");
  source.exec("CREATE TABLE people(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE document_people(document_id TEXT,person_id TEXT)");
  source.prepare("INSERT INTO people VALUES (?,?)").run("linked", JSON.stringify({
    id: "linked", name: "Семён", surname: "Чепчугов", patronymic: "Павлович",
    biography: "Не участвует в поиске".repeat(10_000), events: [{ title: "Private event" }],
  }));
  source.prepare("INSERT INTO people VALUES (?,?)").run("unlinked", JSON.stringify({ id: "unlinked", name: "Другой" }));
  source.exec("INSERT INTO document_people VALUES ('a','linked'),('b','linked')");
  const db = storeDatabase(source);
  const prepare = db.prepare;
  let checked = false;
  db.prepare = (...sql) => {
    const statement = prepare(...sql);
    return { ...statement, all: async (...args) => {
      const rows = await statement.all(...args);
      for (const row of rows)
        assert.deepEqual(Object.keys(row).sort(), ["id", "name", "patronymic", "surname"],
          "heavy JSON must not cross the database boundary");
      checked = true;
      return rows;
    } };
  };
  try {
    assert.deepEqual(await documentSearchPeople(db), [{
      id: "linked", name: "Семён", surname: "Чепчугов", patronymic: "Павлович",
    }]);
    assert.equal(checked, true);
  } finally { await db.close(); }
});

test("document search ranks all words before pagination without loading the full archive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-document-search-"));
  const file = join(dir, "drevo.sqlite");
  const app = await startServer(0, file, true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await app.archive.write(
      { title: "Поиск", description: "", demo: false, people: searchPeople },
      (await app.archive.read()).revision,
    );
    const db = new DatabaseSync(file);
    try {
      for (const document of searchDocuments) {
        const details = {
          documentType: "",
          documentDate: "",
          place: "",
          description: document.description,
          provenance: "",
        };
        db.prepare(
          "INSERT INTO documents (id,title,title_search,file_name,file_size,uploaded_by,created_at,description) VALUES (?,?,?,?,?,?,?,?)",
        ).run(
          document.id,
          document.title,
          documentSearchText(document.title, details),
          `${document.id}.pdf`,
          1,
          "local",
          document.createdAt,
          document.description,
        );
        for (const id of document.people)
          db.prepare(
            "INSERT INTO document_people (document_id,person_id) VALUES (?,?)",
          ).run(document.id, id);
      }
    } finally {
      db.close();
    }
    app.archive.read = async () => {
      throw new Error("Search must not read the full graph");
    };
    const search = async (query: string, extra = "") => {
      const response = await fetch(
        `${base}/api/documents?q=${encodeURIComponent(query)}${extra}`,
      );
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as {
        total: number;
        items: Array<{ id: string }>;
      };
    };
    const result = await search("  ЧЕПЧУГОВ   Павел  ");
    assert.equal(result.total, 5);
    assert.deepEqual(
      result.items.map((item) => item.id),
      rankedSearchIds,
    );
    const page1 = await search("чепчугов павел", "&limit=2");
    const page2 = await search("чепчугов павел", "&limit=2&offset=2");
    const page3 = await search("чепчугов павел", "&limit=2&offset=4");
    assert.equal(page1.total, 5);
    assert.equal(page2.total, 5);
    assert.deepEqual(
      [...page1.items, ...page2.items, ...page3.items].map((item) => item.id),
      rankedSearchIds,
    );
    const reversed = await search("павел чепчугов");
    assert.equal(reversed.total, 5);
    assert.equal(reversed.items[0].id, "exact-person");
    assert.deepEqual(
      (await search("чепчугов семен")).items.map((item) => item.id),
      ["yo-title", "yo-person"],
    );
    assert.deepEqual(
      (await search("Чепчугов Семён")).items.map((item) => item.id),
      ["yo-title", "yo-person"],
    );
    assert.equal((await search("чепчугов отсутствует")).total, 0);
    assert.equal((await search("%' OR 1=1 --")).total, 0);
    const filtered = await search("чепчугов павел", "&personId=ivan");
    assert.equal(
      filtered.total,
      0,
      "different linked people must not supply separate query words",
    );
    const unfiltered = await search("");
    assert.deepEqual(
      unfiltered.items.map((item) => item.id),
      searchDocuments.toReversed().map((item) => item.id),
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
