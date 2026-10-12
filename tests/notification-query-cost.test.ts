import test from "node:test";
import assert from "node:assert/strict";
import { archiveNotificationsStore } from "../src/server/archive-notifications.ts";
import type { StoreDatabase } from "../src/server/store-database.ts";

test("tail pages do not repeat unread aggregation; closed summary does not fetch row bodies", async () => {
  const calls: string[] = [];
  const store = archiveNotificationsStore({ prepare(sqlite: string) {
    return {
      async get() { calls.push(sqlite); return { unread: 8, latest: 80 }; },
      async all() { calls.push(sqlite); return []; },
    };
  } } as unknown as StoreDatabase);
  assert.deepEqual(await store.summary("reader", null), { unread: 8, latest: 80 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith("SELECT count(*)"));
  calls.length = 0;
  assert.deepEqual(await store.tail("reader", null, 60), { items: [], next: null });
  assert.equal(calls.length, 1);
  assert.equal(calls.some(sql => sql.startsWith("SELECT count(*)")), false);
  calls.length = 0;
  await store.list("reader", null);
  assert.equal(calls.filter(sql => sql.startsWith("SELECT count(*)")).length, 1);
  assert.equal(calls.length, 2);
});
