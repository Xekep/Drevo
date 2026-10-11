import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { storeDatabase } from "../src/server/store-database.ts";
import { archiveNotificationsStore } from "../src/server/archive-notifications.ts";
import { userStore } from "../src/server/users.ts";

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  initializeArchiveSchema(sqlite);
  const db = storeDatabase(sqlite);
  const users = await userStore(db);
  await users.register("reader", "Читатель");
  const notifications = archiveNotificationsStore(db);
  const add = (personId: string) => {
    sqlite
      .prepare("INSERT INTO people(id,data) VALUES(?,?)")
      .run(personId, JSON.stringify({ name: personId }));
    return Number(
      sqlite
        .prepare(`INSERT INTO audit_entries
          (at,actor_id,actor_name,action,entity,entity_id,label,details)
          VALUES(?,'other','Другой участник','Добавлено','people',?,'','[]')`)
        .run("2026-10-11T10:00:00.000Z", personId).lastInsertRowid,
    );
  };
  return { sqlite, db, notifications, add };
}

test("scoped read-all leaves previously hidden events unread after access expands", async () => {
  const { sqlite, db, notifications, add } = await fixture();
  try {
    const hidden = add("hidden");
    const visible = add("visible");
    const scope = new Set(["visible"]);
    const received = await notifications.list("reader", scope);
    assert.deepEqual(received.items.map((item) => item.id), [visible]);
    await notifications.readThrough("reader", scope, received.latest);
    const expanded = await notifications.list("reader", null);
    assert.equal(expanded.unread, 1);
    assert.equal(expanded.items.find((item) => item.id === hidden)?.read, false);
    assert.equal(expanded.items.find((item) => item.id === visible)?.read, true);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM notification_cursors").get()!.count,
      0,
      "a scoped read-all never advances the archive-wide cursor",
    );
    await notifications.readThrough("reader", scope, received.latest);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM notification_reads").get()!.count,
      1,
      "repeated scoped read-all is idempotent",
    );
    const later = add("later");
    await notifications.readThrough("reader", new Set(["visible", "later"]), received.latest);
    assert.equal(
      (await notifications.list("reader", null)).items.find((item) => item.id === later)?.read,
      false,
      "a new event after the received watermark stays unread",
    );
  } finally {
    await db.close();
  }
});

test("empty scoped read-all does nothing; unrestricted read-all retains its cursor and receipt cleanup", async () => {
  const { sqlite, db, notifications, add } = await fixture();
  try {
    add("hidden");
    const latest = add("visible");
    await notifications.readThrough("reader", new Set(), Number.MAX_SAFE_INTEGER);
    await notifications.readThrough("reader", new Set(), Number.MAX_SAFE_INTEGER);
    assert.equal((await notifications.list("reader", null)).unread, 2);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM notification_reads").get()!.count, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM notification_cursors").get()!.count, 0);
    await notifications.readThrough("reader", new Set(["visible"]), latest);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM notification_reads").get()!.count, 1);
    const unreadWatermark = (await notifications.list("reader", null)).latest;
    await notifications.readThrough("reader", null, Number.MAX_SAFE_INTEGER);
    assert.equal((await notifications.list("reader", null)).unread, 0);
    assert.equal(
      sqlite.prepare("SELECT read_through FROM notification_cursors WHERE user_id='reader'").get()!.read_through,
      unreadWatermark,
      "the unrestricted cursor is clamped to the current unread watermark",
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM notification_reads").get()!.count, 1);
    const later = add("later");
    await notifications.readThrough("reader", null, later);
    assert.equal(sqlite.prepare("SELECT read_through FROM notification_cursors WHERE user_id='reader'").get()!.read_through, later);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM notification_reads").get()!.count, 0);
    await notifications.readThrough("reader", null, latest);
    assert.equal((await notifications.list("reader", null)).unread, 0);
  } finally {
    await db.close();
  }
});
