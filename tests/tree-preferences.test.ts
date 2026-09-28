import { storeDatabase } from "../src/server/store-database.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { treePreferencesStore } from "../src/server/tree-preferences.ts";
import { userStore } from "../src/server/users.ts";

test("legacy direction becomes individual preferences; deleting an account removes its choice", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    const users = await userStore(storeDatabase(db));
    const admin = await users.register("admin", "Администратор");
    await users.register("reader", "Участник");
    db.exec(`
      INSERT INTO tree_settings(id,reverse_timeline) VALUES(1,1);
      DROP TABLE user_tree_preferences;
      DELETE FROM migrations WHERE id='2026-09-user-tree-preferences';
      DELETE FROM migrations WHERE id='2026-09-user-tree-color-scheme';
    `);
    initializeArchiveSchema(db);
    const preferences = treePreferencesStore(storeDatabase(db));
    assert.deepEqual(await preferences.read("admin"), {
      reverseTimeline: true,
      cardVariant: "portrait",
      colorScheme: "warm",
    });
    assert.deepEqual(
      await preferences.read("reader"),
      await preferences.read("admin"),
    );
    assert.deepEqual(
      await preferences.read("local"),
      await preferences.read("admin"),
    );
    await preferences.write("reader", {
      reverseTimeline: false,
      cardVariant: "portrait",
      colorScheme: "white",
    });
    assert.equal((await preferences.read("admin")).cardVariant, "portrait");
    assert.equal((await preferences.read("reader")).reverseTimeline, false);
    assert.equal((await preferences.read("reader")).colorScheme, "white");
    assert.equal((await preferences.read("admin")).colorScheme, "warm");
    await users.remove(admin, "reader");
    assert.equal(
      db
        .prepare("SELECT 1 FROM user_tree_preferences WHERE user_id='reader'")
        .get(),
      undefined,
    );
    assert.deepEqual(await preferences.read("new-account"), {
      reverseTimeline: false,
      cardVariant: "portrait",
      colorScheme: "warm",
    });
  } finally {
    db.close();
  }
});

test("existing classic cards switch to portrait once without resetting direction or colors", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    const preferences = treePreferencesStore(storeDatabase(db));
    await preferences.write("reader", {
      reverseTimeline: true,
      cardVariant: "classic",
      colorScheme: "white",
    });
    db.exec("DELETE FROM migrations WHERE id='2026-09-default-portrait-cards'");
    initializeArchiveSchema(db);
    assert.deepEqual(await preferences.read("reader"), {
      reverseTimeline: true,
      cardVariant: "portrait",
      colorScheme: "white",
    });
    await preferences.write("reader", {
      reverseTimeline: true,
      cardVariant: "classic",
      colorScheme: "white",
    });
    initializeArchiveSchema(db);
    assert.equal((await preferences.read("reader")).cardVariant, "classic");
  } finally {
    db.close();
  }
});

test("adding color schemes preserves existing personal card and direction choices", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    db.exec(`
      DROP TABLE user_tree_preferences;
      CREATE TABLE user_tree_preferences (
        user_id TEXT PRIMARY KEY,
        reverse_timeline INTEGER NOT NULL CHECK(reverse_timeline IN (0,1)),
        card_variant TEXT NOT NULL CHECK(card_variant IN ('classic','portrait'))
      ) STRICT;
      INSERT INTO user_tree_preferences VALUES('reader',1,'portrait');
      DELETE FROM migrations WHERE id='2026-09-user-tree-color-scheme';
    `);
    initializeArchiveSchema(db);
    const preferences = treePreferencesStore(storeDatabase(db));
    assert.deepEqual(await preferences.read("reader"), {
      reverseTimeline: true,
      cardVariant: "portrait",
      colorScheme: "warm",
    });
    assert.deepEqual(
      await preferences.write("reader", {
        reverseTimeline: true,
        cardVariant: "portrait",
        colorScheme: "white",
      }),
      {
        reverseTimeline: true,
        cardVariant: "portrait",
        colorScheme: "white",
      },
    );
    initializeArchiveSchema(db);
    assert.equal((await preferences.read("reader")).colorScheme, "white");
  } finally {
    db.close();
  }
});
