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
  function login(id: string, name: string, seed: string) {
    const user = userStore(db).register(id, name);
    const value = token(seed);
    db.prepare(
      "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
    ).run(
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
    app.archive.write(family, app.archive.read().revision);
    const admin = login("admin", "Администратор", "a");
    const reader = login("reader", "Читатель", "b");
    const other = login("other", "Другой участник", "c");
    db.prepare(
      "UPDATE users SET approved=1,tree_access='common_ancestors',person_id='boris' WHERE id='reader'",
    ).run();
    db.prepare("UPDATE users SET approved=1 WHERE id='other'").run();

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
    assert.equal(adminComment.item.text, "Кто знает дату рождения?");
    assert.equal((await request(anna, reader.cookie)).status, 404);

    const readerPost = await request(boris, reader.cookie, "POST", {
      text: "Семейное воспоминание",
    });
    assert.equal(readerPost.status, 201);
    const readerComment = (await readerPost.json()) as { item: { id: number } };
    const readerList = (await (await request(boris, reader.cookie)).json()) as {
      items: Array<{ text: string; author: string; canDelete: boolean }>;
    };
    assert.equal(readerList.items[0].text, "Семейное воспоминание");
    assert.equal(readerList.items[0].author, "Читатель");
    assert.equal(readerList.items[0].canDelete, true);
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
    db.prepare("DELETE FROM person_comments WHERE person_id='anna'").run();

    for (let index = 0; index < 22; index++)
      db.prepare(
        "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,?,?,?)",
      ).run("anna", "admin", 1_000 + index, `Сообщение ${index}`);
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

    app.archive.write(
      {
        ...family,
        people: family.people.filter((person) => person.id !== "anna"),
      },
      app.archive.read().revision,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM person_comments WHERE person_id='anna'",
        )
        .get()!.n,
      0,
    );
  } finally {
    await app.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
    rmSync(dir, { recursive: true, force: true });
  }
});
