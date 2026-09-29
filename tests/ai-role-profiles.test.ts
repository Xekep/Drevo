import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { storeDatabase } from "../src/server/store-database.ts";
import {
  aiSettingsStore,
  aiRuntimeConfig,
  defaultAiRoleProfile,
  publicAiStatus,
} from "../src/server/ai-settings.ts";
import { aiUsageStore } from "../src/server/ai-usage.ts";
import { userStore } from "../src/server/users.ts";
import { owns, type ArchiveUser } from "../src/domain/access.ts";
import { aiVision } from "../src/server/ai-vision.ts";
import { isScopedUser } from "../src/domain/tree-access.ts";

const admin: ArchiveUser = {
  id: "local",
  name: "Администратор",
  role: "admin",
  createdAt: "",
  approved: true,
};

test("role profiles inherit old settings, override models and capabilities, validate atomically and keep credentials server-side", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    const settings = await aiSettingsStore(storeDatabase(db));
    const common = {
      ...(await settings.read()),
      folderId: "folder",
      model: "base",
      requestsPerMinute: 6,
      dailyRequests: 100,
      dailyTokens: 10000,
    };
    await settings.write(common, admin);
    for (const role of ["admin", "relative", "researcher", "reader"] as const) {
      const runtime = await aiRuntimeConfig(settings, role);
      assert.equal(runtime.modelUri, "gpt://folder/base");
      assert.equal(runtime.userLimits, null);
    }
    const profile = {
      ...defaultAiRoleProfile(common),
      model: "research-model",
      visionModel: "vision-model",
      webSearchEnabled: true,
      globalSearchEnabled: false,
      pdfEnabled: false,
      dailyRequests: 30,
    };
    await settings.write(
      {
        ...common,
        roleProfiles: { ...common.roleProfiles, researcher: profile },
      },
      admin,
    );
    const runtime = await aiRuntimeConfig(settings, "researcher");
    assert.equal(runtime.modelUri, "gpt://folder/research-model");
    assert.equal(runtime.webSearchEnabled, true);
    assert.equal(runtime.capabilities.globalSearch, false);
    assert.equal(runtime.capabilities.pdf, false);
    assert.equal(runtime.userLimits?.dailyRequests, 30);
    assert.equal(runtime.limits.dailyRequests, 100);
    assert.equal(
      await aiVision(async () => {
        throw new Error("No discovery needed");
      }).modelUri(runtime),
      "gpt://folder/vision-model",
    );
    assert.equal((await aiRuntimeConfig(settings, "relative")).model, "base");
    assert.equal(
      await aiVision(async () => {
        throw new Error("No discovery needed");
      }).modelUri({ ...runtime, folderId: "" }),
      "gpt://folder/vision-model",
    );
    assert.equal(
      Object.hasOwn(await publicAiStatus(settings), "apiKey"),
      false,
    );
    const before = await settings.read();
    for (const profiles of [
      { root: profile },
      { researcher: { ...profile, apiKey: "must-not-be-stored" } },
      { researcher: { ...profile, dailyRequests: -1 } },
      { researcher: { ...profile, pdfEnabled: "false" } },
      { researcher: { ...profile, model: "bad model" } },
    ]) {
      await assert.rejects(
        settings.write({ ...common, roleProfiles: profiles }, admin),
      );
      assert.deepEqual(await settings.read(), before);
    }
    await settings.write({ ...before, enabled: false }, admin);
    assert.equal(
      (await aiRuntimeConfig(settings, "researcher")).enabled,
      false,
    );
    await settings.write(
      {
        ...before,
        roleProfiles: { ...before.roleProfiles, researcher: null },
        model: "new-default",
      },
      admin,
    );
    assert.equal(
      (await aiRuntimeConfig(settings, "researcher")).model,
      "new-default",
    );
  } finally {
    db.close();
  }
});

test("researcher has relative ownership, can be assigned only by admin and does not bypass tree scope", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    const users = await userStore(storeDatabase(db));
    const first = await users.register("admin", "Администратор");
    const member = await users.register("member", "Участник");
    const researcher = await users.setRole(first, member.id, "researcher");
    assert.equal(researcher.role, "researcher");
    assert.equal(researcher.approved, true);
    assert.equal(owns(researcher, { createdBy: "member" }), true);
    assert.equal(owns(researcher, { createdBy: "admin" }), false);
    assert.equal(
      isScopedUser({ ...researcher, treeAccess: "common_ancestors" }),
      true,
    );
    await assert.rejects(users.setRole(researcher, researcher.id, "admin"));
    await assert.rejects(
      users.setRole(first, first.id, "researcher"),
      /последнего администратора/,
    );
    await users.setRole(first, member.id, "reader");
    assert.equal((await users.get(member.id))?.role, "reader");
  } finally {
    db.close();
  }
});

test("upgrading legacy users CHECK preserves sessions, preferences and foreign keys; migration is repeatable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    // Real pre-extension table; initializeArchiveSchema adds all later columns.
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL CHECK (role IN ('admin', 'relative', 'reader')),created_at TEXT NOT NULL DEFAULT '') STRICT;
      INSERT INTO users(id,name,role) VALUES('existing','Участник','relative');
      CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL) STRICT;
      INSERT INTO auth_sessions VALUES('session','existing',9999999999999);
      PRAGMA foreign_keys=ON;`);
    initializeArchiveSchema(db);
    assert.equal(
      db.prepare("SELECT user_id FROM auth_sessions").get()?.user_id,
      "existing",
    );
    db.prepare("UPDATE users SET role='researcher' WHERE id='existing'").run();
    db.prepare(
      "INSERT INTO user_tree_preferences(user_id,reverse_timeline,card_variant) VALUES('existing',1,'portrait')",
    ).run();
    initializeArchiveSchema(db);
    assert.equal(
      db.prepare("SELECT role FROM users WHERE id='existing'").get()?.role,
      "researcher",
    );
    assert.equal(
      db.prepare("SELECT reverse_timeline FROM user_tree_preferences").get()
        ?.reverse_timeline,
      1,
    );
    assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("personal daily limits do not count another user's requests, shared archive budget still applies", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    const usage = aiUsageStore(storeDatabase(db));
    const request = await usage.begin("first", "model");
    await usage.finish(request.id, request.started, {
      status: "ok",
      providerCalls: 1,
      inputTokens: 100,
      outputTokens: 100,
    });
    const limits = { requestsPerMinute: 0, dailyRequests: 1, dailyTokens: 100 };
    await usage.check("second", limits, "user");
    await assert.rejects(
      usage.check("first", limits, "user"),
      /Ваш дневной лимит запросов/,
    );
    await assert.rejects(
      usage.check("first", { ...limits, dailyRequests: 0 }, "user"),
      /Ваш дневной лимит токенов/,
    );
    await assert.rejects(
      usage.check("second", limits),
      /Дневной лимит запросов/,
    );
  } finally {
    db.close();
  }
});
