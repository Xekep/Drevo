import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { treePreferencesStore } from "../src/server/tree-preferences.ts";
import { userStore } from "../src/server/users.ts";

test("legacy direction becomes individual preferences; deleting an account removes its choice", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    const users = userStore(db);
    const admin = users.register("admin", "Администратор");
    users.register("reader", "Участник");
    db.exec(`
      INSERT INTO tree_settings(id,reverse_timeline) VALUES(1,1);
      DROP TABLE user_tree_preferences;
      DELETE FROM migrations WHERE id='2026-09-user-tree-preferences';
    `);
    initializeArchiveSchema(db);
    const preferences = treePreferencesStore(db);
    assert.deepEqual(preferences.read("admin"), {
      reverseTimeline: true,
      cardVariant: "classic",
    });
    assert.deepEqual(preferences.read("reader"), preferences.read("admin"));
    assert.deepEqual(preferences.read("local"), preferences.read("admin"));
    preferences.write("reader", {
      reverseTimeline: false,
      cardVariant: "portrait",
    });
    assert.equal(preferences.read("admin").cardVariant, "classic");
    assert.equal(preferences.read("reader").reverseTimeline, false);
    users.remove(admin, "reader");
    assert.equal(
      db
        .prepare("SELECT 1 FROM user_tree_preferences WHERE user_id='reader'")
        .get(),
      undefined,
    );
    assert.deepEqual(preferences.read("new-account"), {
      reverseTimeline: false,
      cardVariant: "classic",
    });
  } finally {
    db.close();
  }
});
