import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { userStore } from "../src/server/users.ts";

function memory() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

test("production bootstrap requires an explicit initial admin", () => {
  const db = memory();
  try {
    assert.throws(
      () => userStore(db, { requireInitialAdmin: true }),
      /INITIAL_ADMIN_YANDEX_ID/,
    );
  } finally {
    db.close();
  }
});

test("only the configured Yandex ID becomes the first admin", () => {
  const db = memory();
  try {
    const users = userStore(db, {
      requireInitialAdmin: true,
      initialAdminId: "owner-id",
    });
    assert.equal(users.register("stranger", "Читатель").role, "reader");
    assert.equal(users.register("owner-id", "Владелец").role, "admin");
    assert.equal(users.register("later", "Ещё читатель").role, "reader");
  } finally {
    db.close();
  }
});

test("existing installations keep their administrator without bootstrap env", () => {
  const db = memory();
  try {
    const legacy = userStore(db);
    assert.equal(legacy.register("existing-admin", "Администратор").role, "admin");
    const reopened = userStore(db, { requireInitialAdmin: true });
    assert.equal(reopened.get("existing-admin")?.role, "admin");
  } finally {
    db.close();
  }
});
