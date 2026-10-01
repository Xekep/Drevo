import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { userStore } from "../src/server/users.ts";
import type { Family } from "../src/domain/types.ts";

test("person discussion enforces login, visible scope, authorship and origin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-discussion-"));
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://archive.test";
  const app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const family: Family = {
    title: "Обсуждения",
    description: "",
    demo: false,
    people: ["anna", "boris"].map((id) => ({
      id,
      name: id,
      surname: "Тестов",
      patronymic: "",
      sex: "u" as const,
      birth: "",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      column: 0,
      generation: 1,
    })),
  };
  const db = app.archive.db;
  const token = (seed: string) => seed.repeat(64).slice(0, 64);
  async function login(id: string, name: string, seed: string) {
    const user = await (await userStore(db)).register(id, name);
    const value = token(seed);
    await db
      .prepare(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      )
      .run(
        createHash("sha256").update(value).digest("hex"),
        id,
        Date.now() + 3600_000,
      );
    return { user, cookie: `drevo_session=${value}` };
  }
  function request(
    path: string,
    cookie = "",
    method = "GET",
    body?: unknown,
    origin = "https://archive.test",
  ) {
    return fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  try {
    await app.archive.write(family, (await app.archive.read()).revision);
    const admin = await login("admin", "Администратор", "a");
    const reader = await login("reader", "Читатель", "b");
    const other = await login("other", "Другой участник", "c");
    await db
      .prepare(
        "UPDATE users SET approved=1,tree_access='common_ancestors',person_id='boris' WHERE id='reader'",
      )
      .run();
    await db.prepare("UPDATE users SET approved=1 WHERE id='other'").run();

    const anna = "/api/people/anna/discussion";
    const boris = "/api/people/boris/discussion";
    assert.equal((await request(anna)).status, 401);
    assert.equal((await request(anna, reader.cookie)).status, 404);
    assert.equal(
      (await request(anna, reader.cookie, "POST", { text: "Секрет" })).status,
      404,
    );
    assert.equal(
      (
        await request(
          anna,
          admin.cookie,
          "POST",
          { text: "Тест" },
          "https://other.test",
        )
      ).status,
      403,
    );
    assert.equal(
      (await request(anna, admin.cookie, "POST", { text: " " })).status,
      400,
    );
    const created = await request(anna, admin.cookie, "POST", {
      text: "Кто знает дату рождения?",
    });
    assert.equal(created.status, 201);
    const adminComment = (await created.json()) as {
      item: { id: number; text: string; canDelete: boolean };
    };
    assert.equal(adminComment.item.canDelete, true);
    await db.prepare("UPDATE users SET name='Renamed' WHERE id='admin'").run();
    const named = (await (await request(anna, admin.cookie)).json()) as {
      items: Array<{ author: string }>;
    };
    assert.equal(named.items[0].author, admin.user.name);
    await db
      .prepare("UPDATE users SET person_id='anna' WHERE id='admin'")
      .run();
    let cardAuthor = (await (await request(anna, admin.cookie)).json())
      .items[0];
    assert.equal(cardAuthor.author, "Тестов anna");
    assert.equal(cardAuthor.authorPersonId, "anna");
    await db
      .prepare(
        "UPDATE people SET data=json_set(data,'$.name','Новое имя','$.patronymic','Отчество') WHERE id='anna'",
      )
      .run();
    cardAuthor = (await (await request(anna, admin.cookie)).json()).items[0];
    assert.equal(
      cardAuthor.author,
      "Тестов Новое имя Отчество",
      "existing comments use the current card name",
    );
    await db
      .prepare(
        "UPDATE people SET data=json_set(data,'$.name','anna','$.patronymic','') WHERE id='anna'",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text) VALUES('boris','admin','Администратор',1,'Скрытая карточка автора')",
      )
      .run();
    const hiddenAuthor = (await (await request(boris, reader.cookie)).json())
      .items[0];
    assert.equal(hiddenAuthor.authorPersonId, null);
    assert.equal(
      hiddenAuthor.author,
      "Администратор",
      "a scoped reader does not receive a hidden card name",
    );
    const visibleAuthor = (await (await request(boris, admin.cookie)).json())
      .items[0];
    assert.equal(visibleAuthor.authorPersonId, "anna");
    await db
      .prepare(
        "DELETE FROM person_comments WHERE text='Скрытая карточка автора'",
      )
      .run();
    await db.prepare("UPDATE users SET person_id=NULL WHERE id='admin'").run();
    assert.equal(
      (await (await request(anna, admin.cookie)).json()).items[0]
        .authorPersonId,
      null,
    );
    await db
      .prepare("UPDATE users SET name=? WHERE id='admin'")
      .run(admin.user.name);
    await db
      .prepare(
        "INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text) VALUES(?,?,?,?,?)",
      )
      .run("anna", "imported:remote", "Remote Author", 1, "Archive note");
    const imported = (await (await request(anna, admin.cookie)).json()) as {
      items: Array<{ author: string; canDelete: boolean }>;
    };
    assert.equal(imported.items[0].author, "Remote Author");
    assert.equal(
      (imported.items[0] as { authorPersonId?: string | null }).authorPersonId,
      null,
    );
    assert.equal(imported.items[0].canDelete, true);
    await db
      .prepare("DELETE FROM person_comments WHERE author_id='imported:remote'")
      .run();
    assert.equal(adminComment.item.text, "Кто знает дату рождения?");
    assert.equal((await request(anna, reader.cookie)).status, 404);

    const readerPost = await request(boris, reader.cookie, "POST", {
      text: "Семейное воспоминание",
    });
    assert.equal(readerPost.status, 201);
    const readerComment = (await readerPost.json()) as {
      item: { id: number; author: string; authorPersonId: string | null };
    };
    assert.equal(readerComment.item.author, "Тестов boris");
    assert.equal(
      readerComment.item.authorPersonId,
      "boris",
      "new comments immediately expose the author's accessible card",
    );
    const readerList = (await (await request(boris, reader.cookie)).json()) as {
      items: Array<{ text: string; author: string; canDelete: boolean }>;
    };
    assert.equal(readerList.items[0].text, "Семейное воспоминание");
    assert.equal(readerList.items[0].author, "Тестов boris");
    assert.equal(
      (readerList.items[0] as { authorPersonId?: string }).authorPersonId,
      "boris",
    );
    assert.equal(readerList.items[0].canDelete, true);
    const path = `${boris}/${readerComment.item.id}`;
    const original = (await (await request(boris, reader.cookie)).json())
      .items[0];
    assert.equal(original.canEdit, true);
    assert.equal(original.editedAt, null);
    const foreignList = await (await request(boris, admin.cookie)).json();
    assert.equal(foreignList.items[0].canDelete, true);
    assert.equal(foreignList.items[0].canEdit, false);
    for (const cookie of [other.cookie, admin.cookie])
      assert.equal(
        (
          await request(path, cookie, "PATCH", {
            text: "Чужая правка",
            editedAt: null,
          })
        ).status,
        403,
      );
    assert.equal(
      (await request(path, "", "PATCH", { text: "Правка", editedAt: null }))
        .status,
      401,
    );
    assert.equal(
      (
        await request(
          path,
          reader.cookie,
          "PATCH",
          { text: "Правка", editedAt: null },
          "https://other.test",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(path, reader.cookie, "PATCH", {
          text: " ",
          editedAt: null,
        })
      ).status,
      400,
    );
    assert.equal(
      (await request(path, reader.cookie, "PATCH", { text: "Без версии" }))
        .status,
      400,
    );
    assert.equal(
      (
        await request(path, reader.cookie, "PATCH", {
          text: "x".repeat(2001),
          editedAt: null,
        })
      ).status,
      400,
    );
    const editedResponse = await request(path, reader.cookie, "PATCH", {
      text: "    код $x$\n\n**Уточнено** $x^2$",
      editedAt: null,
    });
    assert.equal(editedResponse.status, 200);
    const edited = (await editedResponse.json()).item;
    assert.equal(edited.createdAt, original.createdAt);
    assert.equal(edited.text, "    код $x$\n\n**Уточнено** $x^2$");
    assert.ok(Date.parse(edited.editedAt) > Date.parse(original.createdAt));
    assert.equal(
      (
        await request(path, reader.cookie, "PATCH", {
          text: "Старая версия",
          editedAt: null,
        })
      ).status,
      409,
    );
    const unchanged = await request(path, reader.cookie, "PATCH", {
      text: edited.text,
      editedAt: edited.editedAt,
    });
    assert.equal((await unchanged.json()).item.editedAt, edited.editedAt);
    const raced = await Promise.all(
      ["Первая", "Вторая"].map((text) =>
        request(path, reader.cookie, "PATCH", {
          text,
          editedAt: edited.editedAt,
        }),
      ),
    );
    assert.deepEqual(
      raced.map((response) => response.status).sort(),
      [200, 409],
    );
    const saved = (await (await request(boris, reader.cookie)).json()).items[0];
    assert.ok(["Первая", "Вторая"].includes(saved.text));
    assert.ok(Date.parse(saved.editedAt) > Date.parse(edited.editedAt));
    assert.equal(
      (
        await request(
          `${anna}/${readerComment.item.id}`,
          admin.cookie,
          "PATCH",
          { text: "Не тот человек", editedAt: null },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          `${boris}/${readerComment.item.id}`,
          other.cookie,
          "DELETE",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `${boris}/${readerComment.item.id}`,
          admin.cookie,
          "DELETE",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          `${anna}/${adminComment.item.id}`,
          reader.cookie,
          "DELETE",
        )
      ).status,
      404,
    );
    assert.equal(
      (await request(`${anna}/${adminComment.item.id}`, admin.cookie, "DELETE"))
        .status,
      200,
    );
    assert.deepEqual(
      (await (await request(anna, admin.cookie)).json()).items,
      [],
    );
    for (let index = 0; index < 4; index++)
      assert.equal(
        (await request(anna, admin.cookie, "POST", { text: `Вопрос ${index}` }))
          .status,
        201,
      );
    assert.equal(
      (await request(anna, admin.cookie, "POST", { text: "Лишний вопрос" }))
        .status,
      429,
      "удаление своего сообщения не обходит лимит",
    );
    await db
      .prepare("DELETE FROM person_comments WHERE person_id='anna'")
      .run();

    for (let index = 0; index < 22; index++)
      await db
        .prepare(
          "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,?,?,?)",
        )
        .run("anna", "admin", 1_000 + index, `Сообщение ${index}`);
    const first = (await (await request(anna, admin.cookie)).json()) as {
      items: Array<{ id: number }>;
      nextBefore: number | null;
    };
    assert.equal(first.items.length, 20);
    assert.ok(first.nextBefore);
    const second = (await (
      await request(`${anna}?before=${first.nextBefore}`, admin.cookie)
    ).json()) as {
      items: Array<{ id: number }>;
      nextBefore: number | null;
    };
    assert.equal(second.items.length, 2);
    assert.equal(second.nextBefore, null);
    assert.equal(
      (await request(`${anna}?before=invalid`, admin.cookie)).status,
      400,
    );

    await app.archive.write(
      {
        ...family,
        people: family.people.filter((person) => person.id !== "anna"),
      },
      (await app.archive.read()).revision,
    );
    assert.equal(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM person_comments WHERE person_id='anna'",
        )
        .get())!.n,
      0,
    );
  } finally {
    await app.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
    rmSync(dir, { recursive: true, force: true });
  }
});
