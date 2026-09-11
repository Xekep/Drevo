import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import type { Family, Person } from "../src/domain/index.ts";

const person = (
  id: string,
  birth: string,
  parents: string[] = [],
): Person => ({
  id,
  name: id,
  surname: "Тест",
  patronymic: "",
  sex: "m",
  birth,
  birthPlace: "",
  parents,
  spouses: [],
  sources: [],
  column: 0,
  generation: parents.length ? 2 : 1,
});

function seed(): Family {
  return {
    title: "Точечная запись",
    description: "",
    demo: false,
    people: [person("father", "1950"), person("child", "1980", ["father"])],
    photos: [
      {
        id: "photo",
        url: "/media/photo.png",
        title: "Фото",
        tags: [
          {
            id: "tag",
            personId: "child",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        ],
      },
    ],
  };
}

function observeWrites(store: ReturnType<typeof openArchive>) {
  store.db.exec(`
    CREATE TABLE write_events(table_name TEXT NOT NULL, action TEXT NOT NULL);
    CREATE TRIGGER people_insert AFTER INSERT ON people BEGIN INSERT INTO write_events VALUES('people','insert'); END;
    CREATE TRIGGER people_update AFTER UPDATE ON people BEGIN INSERT INTO write_events VALUES('people','update'); END;
    CREATE TRIGGER people_delete AFTER DELETE ON people BEGIN INSERT INTO write_events VALUES('people','delete'); END;
    CREATE TRIGGER relations_insert AFTER INSERT ON relations BEGIN INSERT INTO write_events VALUES('relations','insert'); END;
    CREATE TRIGGER relations_update AFTER UPDATE ON relations BEGIN INSERT INTO write_events VALUES('relations','update'); END;
    CREATE TRIGGER relations_delete AFTER DELETE ON relations BEGIN INSERT INTO write_events VALUES('relations','delete'); END;
    CREATE TRIGGER photos_insert AFTER INSERT ON photos BEGIN INSERT INTO write_events VALUES('photos','insert'); END;
    CREATE TRIGGER photos_update AFTER UPDATE ON photos BEGIN INSERT INTO write_events VALUES('photos','update'); END;
    CREATE TRIGGER photos_delete AFTER DELETE ON photos BEGIN INSERT INTO write_events VALUES('photos','delete'); END;
    CREATE TRIGGER tags_insert AFTER INSERT ON photo_tags BEGIN INSERT INTO write_events VALUES('photo_tags','insert'); END;
    CREATE TRIGGER tags_update AFTER UPDATE ON photo_tags BEGIN INSERT INTO write_events VALUES('photo_tags','update'); END;
    CREATE TRIGGER tags_delete AFTER DELETE ON photo_tags BEGIN INSERT INTO write_events VALUES('photo_tags','delete'); END;
  `);
}

test("single-person edit updates only that row and preserves untouched rowids", () => {
  const store = openArchive(":memory:", seed());
  try {
    observeWrites(store);
    const beforeChild = Number(
      store.db.prepare("SELECT rowid FROM people WHERE id='child'").get()!.rowid,
    );
    const current = store.read();
    const next = structuredClone(current.family);
    next.people[0].name = "Изменённый отец";

    store.write(next, current.revision);

    const events = store.db
      .prepare(
        "SELECT table_name,action,count(*) AS n FROM write_events GROUP BY table_name,action ORDER BY table_name,action",
      )
      .all()
      .map((row) => ({
        table: String(row.table_name),
        action: String(row.action),
        count: Number(row.n),
      }));
    assert.deepEqual(events, [{ table: "people", action: "update", count: 1 }]);
    assert.equal(
      Number(store.db.prepare("SELECT rowid FROM people WHERE id='child'").get()!.rowid),
      beforeChild,
    );
    assert.equal(store.read().family.people[0].name, "Изменённый отец");
  } finally {
    store.close();
  }
});

test("explicit people reorder falls back to a rewrite and preserves requested order", () => {
  const store = openArchive(":memory:", seed());
  try {
    const current = store.read();
    const next = structuredClone(current.family);
    next.people.reverse();
    const expected = next.people.map((person) => person.id);

    store.write(next, current.revision);

    assert.deepEqual(
      store.read().family.people.map((person) => person.id),
      expected,
    );
  } finally {
    store.close();
  }
});
