import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { userStore } from "../src/server/users.ts";
import { auditStore } from "../src/server/audit.ts";
import type { ArchiveNotificationsPage } from "../src/shared/archive-notifications.ts";
import type { Person } from "../src/domain/types.ts";

test("notifications follow current scope, confirmed events and individual receipts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-notifications-"));
  const oldOrigin = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://archive.test";
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const db = app.archive.db;
  const cookies = new Map<string, string>();
  const users = await userStore(db);
  const person = (id: string): Person => ({
    id,
    name: id,
    surname: "Тестов",
    patronymic: "",
    sex: "u",
    birth: "",
    birthPlace: "",
    parents: [],
    spouses: [],
    sources: [],
    generation: 1,
    column: 0,
  });
  const request = (
    user: string,
    method = "GET",
    body?: unknown,
    origin = "https://archive.test",
    suffix = "",
  ) =>
    fetch(`${base}/api/notifications${suffix}`, {
      method,
      headers: {
        Cookie: cookies.get(user) || "",
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const read = async (user: string, suffix = "") => {
    const response = await request(user, "GET", undefined, undefined, suffix);
    assert.equal(response.status, 200);
    return (await response.json()) as ArchiveNotificationsPage;
  };
  try {
    for (const [index, id] of ["owner", "reader", "other"].entries()) {
      await users.register(id, id);
      const token = String(index + 1).repeat(64);
      await db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        )
        .run(
          createHash("sha256").update(token).digest("hex"),
          id,
          Date.now() + 3600_000,
        );
      cookies.set(id, `drevo_session=${token}`);
    }
    await db.prepare("UPDATE users SET approved=1").run();
    const owner = (await users.get("owner"))!;
    const family = {
      ...(await app.archive.read()).family,
      people: [person("visible"), person("hidden")],
    };
    await app.archive.write(family, (await app.archive.meta()).revision, owner);
    await db
      .prepare(
        "UPDATE users SET tree_access='common_ancestors',person_id='visible' WHERE id='reader'",
      )
      .run();
    assert.equal((await request("")).status, 401);
    assert.equal((await read("owner")).unread, 0, "own actions are excluded");
    const scoped = await read("reader");
    assert.equal(scoped.unread, 1);
    assert.deepEqual(
      scoped.items.map((item) => item.personId),
      ["visible"],
    );
    assert.equal((await read("other")).unread, 2);
    assert.equal(
      (
        await request("reader", "POST", {
          id: (await read("other")).items.find(
            (item) => item.personId === "hidden",
          )!.id,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          "reader",
          "POST",
          { id: scoped.items[0].id },
          "https://foreign.test",
        )
      ).status,
      403,
    );
    assert.equal((await request("reader", "POST", { id: "1" })).status, 400);
    assert.equal(
      (await request("reader", "GET", undefined, undefined, "?before=-1"))
        .status,
      400,
    );
    assert.equal(
      (await request("reader", "POST", { id: scoped.items[0].id })).status,
      200,
    );
    assert.equal((await read("reader")).unread, 0);
    assert.equal((await read("other")).unread, 2, "receipts are user-specific");

    const comment = await fetch(`${base}/api/people/visible/discussion`, {
      method: "POST",
      headers: {
        Cookie: cookies.get("owner")!,
        Origin: "https://archive.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Комментарий для уведомления" }),
    });
    assert.equal(comment.status, 201);
    const commentBody = await comment.json();
    const afterComment = await read("reader");
    assert.equal(afterComment.unread, 1);
    assert.equal(afterComment.items[0].kind, "person_comment");
    assert.ok(
      !JSON.stringify(afterComment).includes("Комментарий для уведомления"),
      "no comment text/audit details are exposed",
    );
    const seen = afterComment.latest;
    const another = person("later");
    another.parents = ["visible"];
    await app.archive.write(
      { ...family, people: [...family.people, another] },
      (await app.archive.meta()).revision,
      owner,
    );
    await request("reader", "POST", { through: seen });
    assert.equal(
      (await read("reader")).unread,
      1,
      "read-all does not swallow a later event",
    );
    assert.equal((await read("reader")).items[0].personId, "later");

    // A rollback cannot create phantom notifications, including AI/import paths.
    const audit = auditStore(db);
    const before = (await read("other")).unread;
    await assert.rejects(
      db.transaction(async () => {
        await audit.record(
          {
            action: "Добавлено",
            entity: "people",
            entityId: "visible",
            label: "Private old name",
            personIds: ["visible"],
            details: [],
          },
          owner,
        );
        throw new Error("rollback");
      }),
    );
    assert.equal((await read("other")).unread, before);
    for (let i = 0; i < 22; i++)
      await audit.record(
        {
          action: "Добавлено",
          entity: "people",
          entityId: "visible",
          label: "Private old name",
          personIds: ["visible"],
          details: [],
        },
        owner,
      );
    const first = await read("other");
    const second = await read("other", `?before=${first.next}`);
    const summaryResponse = await request("other", "GET", undefined, undefined, "?head=1");
    assert.equal(summaryResponse.status, 200);
    assert.deepEqual(await summaryResponse.json(), { unread: first.unread, latest: first.latest });
    const tailResponse = await request("other", "GET", undefined, undefined, `?before=${first.next}&summary=0`);
    assert.equal(tailResponse.status, 200);
    assert.deepEqual(await tailResponse.json(), { items: second.items, next: second.next });
    assert.equal(first.items.length, 20);
    assert.ok(second.items.length > 0);
    assert.ok(second.items.every((item) => item.id < first.items.at(-1)!.id));
    assert.ok(
      !JSON.stringify(first).includes("Private old name"),
      "names come from the current card",
    );
    await db
      .prepare("DELETE FROM person_comments WHERE id=?")
      .run(commentBody.item.id);
    assert.ok(
      !(await read("reader")).items.some(
        (item) => item.kind === "person_comment",
      ),
    );
    await db.prepare("UPDATE users SET approved=0 WHERE id='reader'").run();
    assert.equal((await request("reader")).status, 401);
    await db.prepare("DELETE FROM auth_sessions WHERE user_id='other'").run();
    assert.equal((await request("other")).status, 401);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    if (oldOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = oldOrigin;
  }
});
