import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { createAuth } from "../src/server/auth.ts";
import type { StoreDatabase } from "../src/server/store-database.ts";
import { sessionHttp } from "../src/server/session-http.ts";

test("session status does not deliver an authenticated profile after logout", async () => {
  let active = true;
  let reachedDelivery!: () => void;
  let resumeDelivery!: () => void;
  const deliveryReached = new Promise<void>((resolve) => { reachedDelivery = resolve; });
  const deliveryGate = new Promise<void>((resolve) => { resumeDelivery = resolve; });
  const user = { id: "private-account", name: "Private person", role: "reader",
    approved: true, createdAt: "" } as const;
  const auth = {
    local: false,
    currentUser: async () => active ? user : null,
    canEdit: async () => false,
    accountProfile: async () => active ? { id: user.id, name: user.name } : null,
    isPlatformAdmin: async () => false,
    accountSession: async () => active
      ? { accountId: user.id, tokenHash: "active-session" } : null,
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const db = { kind: "postgres", postgresTransaction: async () => {
    throw new Error("A revoked session must not start delivery");
  } } as unknown as StoreDatabase;
  const handler = sessionHttp(auth, db,
    { yandex: true, vk: async () => false, email: false },
    async () => { reachedDelivery(); await deliveryGate; });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const pending = fetch(`http://127.0.0.1:${port}/api/session`);
    await deliveryReached;
    active = false;
    resumeDelivery();
    const response = await pending;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user, null);
    assert.equal(body.account, null);
    assert.equal(body.canEdit, false);
    assert.doesNotMatch(JSON.stringify(body), /Private person|private-account/);
  } finally {
    resumeDelivery();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
