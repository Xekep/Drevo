import assert from "node:assert/strict";
import { createServer } from "node:http";
import type pg from "pg";
import type { openArchive } from "../../src/server/database.ts";
import { createAuth } from "../../src/server/auth.ts";
import { restoreHttp } from "../../src/server/restore-http.ts";
import { restoreStore } from "../../src/server/restore.ts";
import { sessionTokenHash } from "../../src/server/session-token.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyRestorePreviewDelivery(
  archive: Awaited<ReturnType<typeof openArchive>>,
  source: string,
  bytes: Buffer,
  ownerToken: string,
  origin: string,
  client: pg.Client,
) {
  const restores = restoreStore(archive, source);
  const auth = await createAuth(await userStore(archive.db), archive.db, origin);
  const beforeStages = new Set((await archive.db.prepare("", "SELECT token FROM workflow_stages WHERE kind='restore'").all())
    .map((row) => String(row.token)));
  try {
    for (const kind of ["session", "owner"] as const) {
      let reached!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { reached = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const endpoint = restoreHttp({ restores, auth, db: archive.db, publicOrigin: origin,
        beforePreviewDelivery: async () => { reached(); await gate; } });
      const server = createServer((req, res) => {
        void endpoint(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
          .catch((error) => res.destroy(error));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const pending = fetch(base + "/api/restore/preview", {
          method: "POST", headers: { Cookie: `drevo_session=${ownerToken}`,
            Origin: origin, "X-Drevo-Restore": "1" }, body: new Uint8Array(bytes),
        });
        await Promise.race([ready, pending.then((response) => {
          throw new Error(`Restore preview sent before final guard: ${response.status}`);
        })]);
        if (kind === "session")
          await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [sessionTokenHash(ownerToken)]);
        else
          await client.query("UPDATE archive_owners SET user_id='reader' WHERE archive_id=$1", [archive.db.archiveId]);
        release();
        const response = await pending;
        assert.equal(response.status, kind === "session" ? 401 : 403,
          "completed revoke before preview delivery must deny the private result");
        const body = await response.json() as Record<string, unknown>;
        assert.equal("token" in body, false);
        assert.equal("people" in body, false);
      } finally {
        release();
        if (kind === "session")
          await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
            VALUES($1,'owner',$2) ON CONFLICT(token_hash) DO UPDATE SET expires_at=excluded.expires_at`,
            [sessionTokenHash(ownerToken), Date.now() + 10 * 60_000]);
        else
          await client.query("UPDATE archive_owners SET user_id='owner' WHERE archive_id=$1", [archive.db.archiveId]);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    console.log("runtime_restore_preview_final_access_ok");
  } finally {
    const after = await archive.db.prepare("", "SELECT token FROM workflow_stages WHERE kind='restore'").all();
    for (const row of after)
      if (!beforeStages.has(String(row.token))) await restores.discard(String(row.token));
    await restores.close();
  }
}
