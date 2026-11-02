import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { extendDiscussionText } from "../src/server/schema.ts";

test("discussion extension preserves edited messages, attachments and deleted ID history", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE migrations(id TEXT PRIMARY KEY);
      CREATE TABLE people(id TEXT PRIMARY KEY);
      INSERT INTO people VALUES('p');
      CREATE TABLE person_comments(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT REFERENCES people(id),
        author_id TEXT,author_name TEXT,created_ms INTEGER,text TEXT CHECK(length(text)<=2000),updated_ms INTEGER,attachments TEXT);
      INSERT INTO person_comments VALUES(4,'p','a','Автор',100,'Текст',200,'[{"id":"file"}]');
      INSERT INTO person_comments VALUES(99,'p','a','Автор',100,'Удалён',NULL,'[]');
      DELETE FROM person_comments WHERE id=99;`);
    const before = db.prepare("SELECT * FROM person_comments").all();
    extendDiscussionText(db);
    extendDiscussionText(db);
    assert.deepEqual(db.prepare("SELECT * FROM person_comments").all(), before);
    const insert = db.prepare("INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES('p','a',300,?)");
    assert.equal(insert.run("Я".repeat(4000)).lastInsertRowid, 100);
    assert.throws(() => insert.run("Я".repeat(4001)), /CHECK/);
    assert.throws(() => insert.run(" "), /CHECK/);
    db.prepare("DELETE FROM people WHERE id='p'").run();
    assert.equal(db.prepare("SELECT count(*) AS n FROM person_comments").get()!.n, 0);
  } finally { db.close(); }
});
