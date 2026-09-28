import { storeDatabase } from "../src/server/store-database.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { userStore } from "../src/server/users.ts";
import { initializeArchiveSchema } from "../src/server/schema.ts";

function memory() {
  const db = new DatabaseSync(":memory:");
  initializeArchiveSchema(db);
  return db;
}

test("production bootstrap requires an explicit initial admin", async () => {
  const db = memory();
  try {
    await assert.rejects(
      async () =>
        await userStore(storeDatabase(db), { requireInitialAdmin: true }),
      /INITIAL_ADMIN_YANDEX_ID/,
    );
  } finally {
    db.close();
  }
});

test("only the configured Yandex ID becomes the first admin", async () => {
  const db = memory();
  try {
    const users = await userStore(storeDatabase(db), {
      requireInitialAdmin: true,
      initialAdminId: "owner-id",
    });
    assert.equal((await users.register("stranger", "Читатель")).role, "reader");
    assert.equal((await users.register("owner-id", "Владелец")).role, "admin");
    assert.equal(
      (await users.register("later", "Ещё читатель")).role,
      "reader",
    );
  } finally {
    db.close();
  }
});

test("existing installations keep their administrator without bootstrap env", async () => {
  const db = memory();
  try {
    const legacy = await userStore(storeDatabase(db));
    assert.equal(
      (await legacy.register("existing-admin", "Администратор")).role,
      "admin",
    );
    const reopened = await userStore(storeDatabase(db), {
      requireInitialAdmin: true,
    });
    assert.equal((await reopened.get("existing-admin"))?.role, "admin");
  } finally {
    db.close();
  }
});
