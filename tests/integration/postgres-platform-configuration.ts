import assert from "node:assert/strict";
import { createServer } from "node:http";
import type pg from "pg";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { adminAccessHttp } from "../../src/server/admin-access-http.ts";
import { adminVkAuthHttp } from "../../src/server/admin-vk-auth-http.ts";
import { adminEmailAuthHttp } from "../../src/server/admin-email-auth-http.ts";
import { emailAuthSettingsStore } from "../../src/server/email-auth-settings.ts";
import { adminResearchResourcesHttp } from "../../src/server/admin-research-resources-http.ts";
import { createAuth } from "../../src/server/auth.ts";
import { userStore } from "../../src/server/users.ts";
import { settingsStore } from "../../src/server/settings.ts";
import { researchCatalogStore } from "../../src/server/research-catalog.ts";
import { vkAuthSettingsStore } from "../../src/server/vk-auth-settings.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { readStorageLimits } from "../../src/server/storage-limits.ts";
import { DEFAULT_STORAGE_LIMITS } from "../../src/shared/storage-limits.ts";
import { initializePlatformConfiguration } from "../../src/server/platform-configuration.ts";

export async function verifyPlatformConfigurationMigration(db: StoreDatabase,
  client: pg.Client) {
  await db.prepare("", "INSERT INTO upload_limits(id,data) VALUES(1,?)")
    .run(JSON.stringify({ ...DEFAULT_STORAGE_LIMITS, admin: 2 }));
  await db.prepare("", "INSERT INTO vk_auth_settings(id,enabled,client_id) VALUES(1,1,'12345')")
    .run();
  await client.query("SELECT set_config('drevo.archive_id','private-091-fixture',false)");
  await client.query(`INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version)
    VALUES('private-091-fixture','Private fixture','',false,0,18)`);
  await client.query(`INSERT INTO research_categories(archive_id,id,name,sort_order)
    VALUES('private-091-fixture','preexisting-other-category','Private other category',0)`);
  await client.query(`INSERT INTO research_resources
    (archive_id,id,category_id,name,url,description,sort_order)
    VALUES('private-091-fixture','preexisting-other-resource','preexisting-other-category',
      'Private before migration','https://private-before.invalid/path',
      'Kept in the legacy tenant only',0)`);
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  await initializePlatformConfiguration(db, "runtime-test");
  assert.equal((await readStorageLimits(db)).admin, 2,
    "the primary archive's existing upload limits become the platform limits");
  assert.equal((await vkAuthSettingsStore(db).read()).clientId, "12345",
    "the primary archive's existing VK configuration becomes platform-wide");
  assert.ok((await researchCatalogStore(db).list())
    .flatMap((category) => category.resources)
    .some((resource) => resource.name === "Primary custom resource"),
  "the copied JSONB search configuration remains readable in the global catalog");
  assert.deepEqual((await client.query(`SELECT id,url FROM research_resources
    WHERE name='Primary custom resource'`)).rows,
  (await client.query(`SELECT id,url FROM platform_research_resources
    WHERE name='Primary custom resource'`)).rows,
  "the primary custom resource keeps its ID and URL; the legacy row remains");
  await initializePlatformConfiguration(db, "runtime-test");
  assert.equal((await client.query(`SELECT count(*)::int AS n
    FROM platform_research_resources WHERE name='Primary custom resource'`)).rows[0].n, 1,
  "the one-time primary migration is idempotent");
  assert.equal((await client.query(`SELECT count(*)::int AS n
    FROM platform_research_resources WHERE id='preexisting-other-resource'`)).rows[0].n, 0,
  "migration never publishes another archive's pre-existing private URL");
  await client.query("SELECT set_config('drevo.archive_id','private-091-fixture',false)");
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM research_resources
    WHERE id='preexisting-other-resource'`)).rows[0].n, 1,
  "the other archive's private legacy row remains available for operator review");
  await client.query("DELETE FROM archives WHERE id='private-091-fixture'");
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
}

export async function verifySharedPlatformConfiguration({
  rootDb, otherDb, rootBase, otherBase, headers, client,
}: {
  rootDb: StoreDatabase; otherDb: StoreDatabase;
  rootBase: string; otherBase: string;
  headers: Record<string, string>; client: pg.Client;
}) {
  await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
  await client.query(`INSERT INTO research_categories(archive_id,id,name,sort_order)
    VALUES('other-archive','private-other-category','Other archive only',0)`);
  await client.query(`INSERT INTO research_resources
    (archive_id,id,category_id,name,url,description,sort_order)
    VALUES('other-archive','private-other-resource','private-other-category',
      'Private legacy link','https://private-other.invalid/path',
      'Retained in the old tenant table only',0)`);
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  const rootDirectory = await fetch(rootBase + "/api/research-resources", { headers });
  const otherDirectory = await fetch(otherBase + "/api/research-resources", { headers });
  assert.equal(rootDirectory.status, 200);
  assert.equal(otherDirectory.status, 200);
  const rootCatalog = await rootDirectory.text();
  assert.equal(await otherDirectory.text(), rootCatalog,
    "both archives read the same primary global catalog");
  assert.match(rootCatalog, /Primary custom resource/);
  assert.doesNotMatch(rootCatalog, /Private legacy link|private-other\.invalid/,
    "another archive's legacy URL is retained but never globally published");
  assert.equal((await readStorageLimits(otherDb)).admin,
    (await readStorageLimits(rootDb)).admin);
  assert.equal((await vkAuthSettingsStore(otherDb).read()).clientId,
    (await vkAuthSettingsStore(rootDb).read()).clientId);
  const priorLimits = await readStorageLimits(otherDb);
  const changedLimits = { ...priorLimits, relative: 3 };
  const limitsWrite = await fetch(otherBase + "/api/settings/storage", {
    method: "PUT", headers,
    body: JSON.stringify({ expected: priorLimits, next: changedLimits }),
  });
  assert.equal(limitsWrite.status, 200, await limitsWrite.text());
  assert.equal((await readStorageLimits(rootDb)).relative, 3,
    "a setting written from the second archive applies to the first");
  assert.equal((await fetch(otherBase + "/api/settings/storage", {
    method: "PUT", headers,
    body: JSON.stringify({ expected: changedLimits, next: priorLimits }),
  })).status, 200);
  const vkWrite = await fetch(otherBase + "/api/admin/auth/vk", {
    method: "PUT", headers,
    body: JSON.stringify({ enabled: true, clientId: "67890" }),
  });
  assert.equal(vkWrite.status, 200, await vkWrite.text());
  assert.equal((await vkAuthSettingsStore(rootDb).read()).clientId, "67890",
    "the primary OAuth runtime reads the common VK configuration");
  assert.equal((await fetch(otherBase + "/api/admin/auth/vk", {
    method: "PUT", headers,
    body: JSON.stringify({ enabled: true, clientId: "12345" }),
  })).status, 200);
  const categoryWrite = await fetch(otherBase + "/api/admin/research-resources/categories", {
    method: "POST", headers,
    body: JSON.stringify({ name: "Shared platform category" }),
  });
  assert.equal(categoryWrite.status, 201, await categoryWrite.clone().text());
  const newCategory = (await categoryWrite.json() as {
    categories: Array<{ id: string; name: string }>;
  }).categories.find((category) => category.name === "Shared platform category");
  assert.ok(newCategory);
  assert.match(await fetch(rootBase + "/api/research-resources", { headers })
    .then((response) => response.text()), /Shared platform category/);
  assert.equal((await fetch(otherBase +
    `/api/admin/research-resources/categories/${newCategory.id}`, {
    method: "DELETE", headers,
  })).status, 200);
}

/** Real HTTP handoff and two SQL connections; no OAuth/provider request. */
export async function verifyPlatformConfigurationRevocation(
  db: StoreDatabase,
  client: pg.Client,
) {
  const actorId = "platform-config-revoke-fixture";
  const token = newSessionToken();
  const tokenHash = sessionTokenHash(token);
  const origin = "https://platform-config.invalid";
  await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Config reviewer',$2)",
    [actorId, new Date().toISOString()]);
  await client.query("INSERT INTO platform_admins(account_id) VALUES($1)", [actorId]);
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
    [tokenHash, actorId, Date.now() + 600_000],
  );
  const users = await userStore(db);
  const auth = await createAuth(users, db, origin);
  let gate: { reached: () => void; wait: Promise<void> } | null = null;
  const guardedAuth = {
    ...auth,
    isPlatformAdmin: async (req: Parameters<typeof auth.isPlatformAdmin>[0]) => {
      const allowed = await auth.isPlatformAdmin(req);
      if (allowed && gate) {
        gate.reached();
        await gate.wait;
      }
      return allowed;
    },
  };
  const handlers = [
    adminAccessHttp({ db, auth: guardedAuth, users,
      visibility: await settingsStore(db), publicOrigin: origin }),
    adminVkAuthHttp(guardedAuth, vkAuthSettingsStore(db, origin), origin),
    adminEmailAuthHttp(guardedAuth, emailAuthSettingsStore(db, origin), origin),
    adminResearchResourcesHttp({ auth: guardedAuth,
      catalog: researchCatalogStore(db), publicOrigin: origin }),
  ];
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    void (async () => {
      for (const handle of handlers)
        if (await handle(req, res, url)) return;
      res.writeHead(404).end();
    })().catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    Cookie: `drevo_session=${token}`,
    Origin: origin,
    "Content-Type": "application/json",
  };
  async function snapshot() {
    return {
      storage: JSON.stringify(await readStorageLimits(db)),
      vk: JSON.stringify(await vkAuthSettingsStore(db, origin).read()),
      email: JSON.stringify(await emailAuthSettingsStore(db, origin).read()),
      emailAudit: (await client.query("SELECT count(*)::int AS n FROM platform_config_audit WHERE item_id='email-auth'")).rows[0].n,
      categories: JSON.stringify(await researchCatalogStore(db).list()),
    };
  }
  async function revokedWrite(path: string, body: unknown,
    revoke: "grant" | "session") {
    let reached!: () => void;
    let release!: () => void;
    const reachedGate = new Promise<void>((resolve) => { reached = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    gate = { reached, wait };
    const before = await snapshot();
    const pending = fetch(base + path, {
      method: path === "/api/settings/storage" || path === "/api/admin/auth/vk" || path === "/api/admin/auth/email" ? "PUT" : "POST",
      headers,
      body: JSON.stringify(body),
    });
    try {
      await Promise.race([
        reachedGate,
        pending.then(async (response) => {
          throw new Error(`Configuration write skipped the auth barrier: ${response.status}`);
        }),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("Configuration auth barrier timed out")), 5000).unref()),
      ]);
      if (revoke === "grant")
        await client.query("DELETE FROM platform_admins WHERE account_id=$1", [actorId]);
      else
        await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [tokenHash]);
      release();
      const response = await pending;
      assert.equal(response.status, 403, await response.text());
      assert.deepEqual(await snapshot(), before,
        "a completed platform revoke cannot commit any configuration change");
    } finally {
      release();
      gate = null;
      if (revoke === "grant")
        await client.query("INSERT INTO platform_admins(account_id) VALUES($1) ON CONFLICT DO NOTHING",
          [actorId]);
    }
  }
  try {
    // Platform access comes from the account, not a root-archive membership.
    for (const path of ["/api/settings/storage", "/api/admin/auth/vk", "/api/admin/auth/email",
      "/api/admin/research-resources"])
      assert.equal((await fetch(base + path, { headers })).status, 200,
        `${path} is available to a platform admin without archive membership`);
    const current = await readStorageLimits(db);
    await revokedWrite("/api/settings/storage", {
      expected: current, next: { ...current, relative: 1 },
    }, "grant");
    await revokedWrite("/api/admin/auth/vk", {
      enabled: true, clientId: "67890",
    }, "grant");
    const email = emailAuthSettingsStore(db, origin);
    const smtp = { enabled: false, host: "smtp.example.org", port: 587,
      user: "mail-user", from: "mail@example.org", password: "smtp-fixture-secret" };
    const emailSession = { accountId: actorId, tokenHash };
    assert.equal((await email.write(smtp, emailSession)).hasPassword, true);
    const cipher = (await client.query("SELECT password_cipher FROM platform_email_auth_settings WHERE id=1")).rows[0].password_cipher;
    assert.ok(cipher.startsWith("v1."));
    assert.ok(!cipher.includes(smtp.password));
    const otherStore = emailAuthSettingsStore(db, origin);
    assert.equal((await otherStore.runtime()).enabled, false);
    const withoutSecret = { enabled: smtp.enabled, host: smtp.host, port: smtp.port,
      user: smtp.user, from: smtp.from };
    assert.equal((await email.write({ ...withoutSecret, enabled: true }, emailSession)).available, true);
    assert.equal((await otherStore.runtime()).enabled, true,
      "another runtime reads changes without a restart");
    assert.equal((await client.query("SELECT password_cipher FROM platform_email_auth_settings WHERE id=1")).rows[0].password_cipher, cipher,
      "omitting a password preserves the current ciphertext");
    assert.ok(!JSON.stringify(await email.read()).includes(smtp.password));
    await assert.rejects(email.write({ ...withoutSecret, enabled: true, password: null }, emailSession), /включения/);
    assert.equal((await email.read()).available, true, "failed validation leaves the stored configuration intact");
    await revokedWrite("/api/admin/auth/email", { ...withoutSecret, enabled: false }, "grant");
    await revokedWrite("/api/admin/auth/email/test", { to: "test@example.org" }, "grant");
    assert.equal((await email.write({ ...withoutSecret, password: null }, emailSession)).hasPassword, false);
    assert.equal((await otherStore.runtime()).enabled, false);
    await client.query("DELETE FROM platform_email_auth_settings WHERE id=1");
    await revokedWrite("/api/admin/research-resources/categories", {
      name: "Revoked category",
    }, "grant");
    // The singleton is installed during bootstrap. Competing first edits must
    // serialize on the same row and respect the optimistic expected value.
    const expected = await readStorageLimits(db);
    const edits = await Promise.all([1, 2].map((extra) => fetch(
      base + "/api/settings/storage", {
        method: "PUT", headers,
        body: JSON.stringify({ expected,
          next: { ...expected, relative: (expected.relative ?? 0) + extra } }),
      },
    )));
    assert.deepEqual(edits.map((response) => response.status).sort(), [200, 409]);
    const afterRace = await readStorageLimits(db);
    assert.ok(afterRace.relative === (expected.relative ?? 0) + 1 ||
      afterRace.relative === (expected.relative ?? 0) + 2);
    const reset = await fetch(base + "/api/settings/storage", {
      method: "PUT", headers,
      body: JSON.stringify({ expected: afterRace, next: expected }),
    });
    assert.equal(reset.status, 200, await reset.text());
    await revokedWrite("/api/admin/auth/email", withoutSecret, "session");
    // Restore the fixture session for the existing session-revocation case.
    await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [tokenHash, actorId, Date.now() + 600_000]);
    await revokedWrite("/api/admin/research-resources/categories", {
      name: "Logged-out category",
    }, "session");
    console.log("platform_configuration_completed_revoke_verified");
  } finally {
    gate = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.query("DELETE FROM accounts WHERE id=$1", [actorId]);
  }
}
