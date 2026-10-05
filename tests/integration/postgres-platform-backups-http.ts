import assert from "node:assert/strict";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
export async function verifyPlatformBackupsHttp(base: string, ownerHeaders: HeadersInit, readerHeaders: HeadersInit, client: pg.Client) {
  // The platform coordinator claims its file lock outside archive transactions.
  // Validate the real raw PostgreSQL permission transaction through HTTP.
  {
    const backupHeaders = new Headers(ownerHeaders); backupHeaders.set("X-Drevo-Backup", "1");
    const listed = await fetch(base + "/api/platform/backups", { headers: ownerHeaders });
    assert.equal(listed.status, 200, await listed.clone().text());
    const platformStatus = await listed.json();
    assert.equal((await fetch(base + "/api/platform/backups", { headers: readerHeaders })).status, 403);
    const saved = await fetch(base + "/api/platform/backups/settings", {
      method: "PUT", headers: backupHeaders,
      body: JSON.stringify({ ...platformStatus.settings, enabled: false }),
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal((await saved.json()).enabled, false);
    const platformOnly = "backup-only-" + randomUUID(), token = newSessionToken();
    await client.query("INSERT INTO accounts(id,name) VALUES($1,'Платформенный оператор без древа')", [platformOnly]);
    try {
      await client.query("INSERT INTO platform_admins(account_id) VALUES($1)", [platformOnly]);
      await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
        [sessionTokenHash(token), platformOnly, Date.now() + 60000]);
      const onlyHeaders = new Headers(backupHeaders); onlyHeaders.set("Cookie", "drevo_session=" + token);
      assert.equal((await fetch(base + "/api/platform/backups", { headers: onlyHeaders })).status, 200);
      const onlySave = await fetch(base + "/api/platform/backups/settings", {
        method: "PUT", headers: onlyHeaders, body: JSON.stringify({ ...platformStatus.settings, enabled: false }),
      });
      assert.equal(onlySave.status, 200, await onlySave.clone().text());
      assert.equal((await fetch(base + "/api/backups", { headers: onlyHeaders })).status, 403);
    } finally { await client.query("DELETE FROM accounts WHERE id=$1", [platformOnly]); }
    const unavailable = await fetch(base + "/api/platform/backups/create", {
      method: "POST", headers: backupHeaders,
    });
    assert.equal(unavailable.status, 503, await unavailable.clone().text());
    const check = await fetch(base + "/api/platform/backups/check", {
      method: "POST", headers: backupHeaders,
      body: JSON.stringify({ ...platformStatus.settings, storage: "remote",
        remoteHost: "ci-missing-vault", remoteDirectory: "/ci-backups" }),
    });
    assert.equal(check.status, 202, await check.clone().text());
    for (let attempt = 0; attempt < 100; attempt++) {
      const polled = await fetch(base + "/api/platform/backups", { headers: ownerHeaders }).then((r) => r.json());
      if (polled.job?.state !== "running") { assert.equal(polled.job.state, "failed"); break; }
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (attempt === 99) assert.fail("Platform remote check did not settle");
    }
  }
}
