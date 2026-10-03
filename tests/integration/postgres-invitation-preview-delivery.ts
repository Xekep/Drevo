import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type pg from "pg";
import type { Client } from "pg";
import { accountInvitationsHttp } from "../../src/server/account-invitations-http.ts";
import { archiveInvitations } from "../../src/server/archive-invitations.ts";
import { createAuth } from "../../src/server/auth.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyInvitationPreviewDelivery(db: StoreDatabase, client: Client) {
  const archiveId = "runtime-test";
  const origin = "https://invitation-preview.invalid";
  await client.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
  const users = await userStore(db);
  const owner = await users.get("owner");
  assert.ok(owner && owner.role === "admin");
  const auth = await createAuth(users, db, origin);
  const invitations = archiveInvitations(db);
  const makeInvitation = async () => {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    await client.query(
      `INSERT INTO archive_invitations
         (archive_id,id,token_hash,role,created_by,created_at,expires_at)
       VALUES($1,$2,$3,'reader','owner',$4,$5)`,
      [archiveId, id, createHash("sha256").update(token).digest("hex"),
        new Date(now).toISOString(), new Date(now + 600_000).toISOString()],
    );
    return { id, token };
  };
  const headers = { Origin: origin, "Content-Type": "application/json" };
  const preview = (base: string, token: string) => fetch(base + "/api/account/invitations/preview", {
    method: "POST", headers, body: JSON.stringify({ archiveId, token }),
  });
  let revokedBeforeFinalCheck = { status: 0, leakedRole: false };
  const first = await makeInvitation();
  try {
    let reachedRead!: () => void;
    let resumeRead!: () => void;
    const readReached = new Promise<void>((resolve) => { reachedRead = resolve; });
    const readGate = new Promise<void>((resolve) => { resumeRead = resolve; });
    let gated = true;
    const gatedDb: StoreDatabase = {
      ...db,
      postgresTransaction: async <T>(work: (client: pg.PoolClient) => Promise<T>) =>
        db.postgresTransaction!(async (transactionClient) => {
          const value = await work(transactionClient);
          if (!gated) {
            gated = true;
            reachedRead();
            await readGate;
          }
          return value;
        }),
    };
    const handler = accountInvitationsHttp(gatedDb, auth, origin);
    const server = createServer((req, res) => {
      void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const active = await preview(base, first.token);
      assert.equal(active.status, 200);
      assert.equal((await active.json()).role, "reader",
        "a valid bearer can still preview a live invitation");
      // Only gate the second request, after the first transaction has read
      // title/role but before the final delivery authorization.
      gated = false;
      const held = preview(base, first.token);
      await Promise.race([
        readReached,
        held.then(() => { throw new Error("Invitation preview finished before read barrier"); }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Invitation preview missed read barrier")), 30_000);
          timer.unref();
        }),
      ]);
      assert.equal(await invitations.revoke(owner, first.id), true);
      resumeRead();
      const response = await held;
      const body = await response.text();
      revokedBeforeFinalCheck = {
        status: response.status,
        leakedRole: /"role":"reader"/.test(body),
      };
    } finally {
      resumeRead();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await client.query("DELETE FROM archive_invitations WHERE archive_id=$1 AND id=$2", [archiveId, first.id]);
  }

  const second = await makeInvitation();
  let revokedBeforeDelivery = false;
  try {
    let reachedEnd!: () => void;
    let resumeEnd!: () => void;
    const endReached = new Promise<void>((resolve) => { reachedEnd = resolve; });
    const endGate = new Promise<void>((resolve) => { resumeEnd = resolve; });
    const handler = accountInvitationsHttp(db, auth, origin);
    const server = createServer((req, res) => {
      const originalEnd = res.end.bind(res);
      res.end = ((...args: Parameters<ServerResponse["end"]>) => {
        reachedEnd();
        void endGate.then(() => originalEnd(...args));
        return res;
      }) as ServerResponse["end"];
      void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const held = preview(base, second.token);
      await Promise.race([
        endReached,
        held.then(() => { throw new Error("Invitation preview finished before delivery barrier"); }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Invitation preview missed delivery barrier")), 30_000);
          timer.unref();
        }),
      ]);
      const revocation = invitations.revoke(owner, second.id);
      revokedBeforeDelivery = await Promise.race([
        revocation.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
      ]);
      resumeEnd();
      const response = await held;
      assert.equal(response.status, 200);
      assert.equal((await response.json()).role, "reader");
      assert.equal(await revocation, true);
      assert.equal((await preview(base, second.token)).status, 410);
    } finally {
      resumeEnd();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await client.query("DELETE FROM archive_invitations WHERE archive_id=$1 AND id=$2", [archiveId, second.id]);
  }
  assert.deepEqual({ revokedBeforeFinalCheck, revokedBeforeDelivery }, {
    revokedBeforeFinalCheck: { status: 410, leakedRole: false },
    revokedBeforeDelivery: false,
  }, "revocation before final check hides the preview; revocation after its lock waits for delivery");
  console.log("invitation_preview_delivery_revocation_verified");
}
