import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import { aiAttachmentStore } from "../../src/server/ai-attachments.ts";
import { aiChatStore } from "../../src/server/ai-chats.ts";
import { aiResearchHttp } from "../../src/server/ai-research-http.ts";
import { aiSettingsStore } from "../../src/server/ai-settings.ts";
import { aiUsageStore } from "../../src/server/ai-usage.ts";
import { createAuth } from "../../src/server/auth.ts";
import type { openArchive } from "../../src/server/database.ts";
import { imagePreviews } from "../../src/server/image-previews.ts";
import { mediaStore } from "../../src/server/media.ts";
import { researchCatalogStore } from "../../src/server/research-catalog.ts";
import { researchSuggestionStore } from "../../src/server/research-suggestions.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { userStore } from "../../src/server/users.ts";
import { aiChatAccessScope } from "../../src/server/ai-chat-access-scope.ts";

export async function verifyAiAttachmentDelivery(
  archive: Awaited<ReturnType<typeof openArchive>>,
  client: Client,
) {
  const db = archive.db;
  const origin = "https://ai-attachment-delivery.invalid";
  const previousTier = await client.query<{ full_access: boolean }>(
    "SELECT full_access FROM account_tiers WHERE account_id='owner'");
  await client.query(`INSERT INTO account_tiers(account_id,full_access)
    VALUES('owner',true) ON CONFLICT(account_id) DO UPDATE SET full_access=true`);
  const owner = await (await userStore(db)).get("owner");
  assert.ok(owner);
  const chats = aiChatStore(db);
  const chat = await chats.create(owner.id, aiChatAccessScope(owner));
  const directory = await mkdtemp(join(tmpdir(), "drevo-ai-attachment-delivery-"));
  const uploadsDirectory = join(directory, "uploads");
  const attachments = aiAttachmentStore(uploadsDirectory, chats);
  const sentinel = "private-ai-attachment-delivery-marker";
  const [file] = await attachments.save(chat.id, [{
    name: "evidence.txt", type: "text/plain", bytes: Buffer.from(sentinel),
  }]);
  await chats.append(chat.id, "user", "Attachment delivery", { attachments: [file] });
  const auth = await createAuth(await userStore(db), db, origin);
  let bumpRevisionOnDelivery = false;
  const handler = aiResearchHttp({
    archive, auth,
    suggestions: researchSuggestionStore(db),
    aiSettings: await aiSettingsStore(db),
    usage: aiUsageStore(db),
    media: mediaStore(uploadsDirectory),
    previewImage: imagePreviews(join(directory, "previews")),
    researchCatalog: researchCatalogStore(db),
    publicOrigin: origin,
    uploadsDirectory,
    attachmentDeliveryDeadlineMs: 2_000,
    beforeAttachmentDelivery: async () => {
      if (!bumpRevisionOnDelivery) return;
      bumpRevisionOnDelivery = false;
      await client.query("UPDATE archives SET revision=revision+1 WHERE id=$1", [db.archiveId]);
    },
  });
  type Barrier = { reached: () => void; gate: Promise<void>; firstByte?: boolean };
  let barrier: Barrier | null = null;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === file.url && barrier) {
      const waiting = barrier;
      barrier = null;
      const end = res.end.bind(res);
      res.end = ((body: Buffer) => {
        if (waiting.firstByte) {
          assert.ok(Buffer.isBuffer(body) && body.length > 1);
          res.write(body.subarray(0, 1));
          waiting.reached();
          void waiting.gate.then(() => end(body.subarray(1)));
          return res;
        }
        waiting.reached();
        void waiting.gate.then(() => end(body));
        return res;
      }) as typeof res.end;
    }
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const tokens: string[] = [];
  const session = async (userId = "owner") => {
    const token = newSessionToken();
    const hash = sessionTokenHash(token);
    tokens.push(hash);
    await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES($1,$2,$3)`, [hash, userId, Date.now() + 600_000]);
    return { hash, headers: { Cookie: `drevo_session=${token}` } };
  };
  const until = (message: string) => new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 10_000);
    timer.unref();
  });
  const race = async (
    headers: { Cookie: string }, revoke: () => Promise<unknown>, nextStatus: number,
    checkArchiveWritable = false, firstByte = false,
  ) => {
    let reached!: () => void, release!: () => void;
    const atEnd = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    barrier = { reached, gate, firstByte };
    const pending = fetch(base + file.url, { headers });
    let revoking: Promise<unknown> | undefined;
    try {
      await Promise.race([atEnd, until("AI attachment missed response barrier")]);
      if (firstByte) {
        const started = await Promise.race([pending,
          until("AI attachment did not send its first byte")]);
        assert.equal(started.status, 200);
      }
      if (checkArchiveWritable) {
        await client.query("BEGIN");
        try {
          assert.equal((await client.query(
            "SELECT id FROM archives WHERE id=$1 FOR UPDATE NOWAIT", [db.archiveId],
          )).rows[0]?.id, db.archiveId,
          "private download must not block ordinary archive edits");
        } finally { await client.query("ROLLBACK"); }
      }
      revoking = revoke();
      const order = await Promise.race([
        revoking.then(() => "completed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 250)),
      ]);
      release();
      const response = await pending;
      assert.equal(response.status, 200);
      assert.equal(await response.text(), sentinel);
      assert.equal(order, "waiting",
        "a completed access or chat revoke must not precede private attachment bytes");
      await revoking;
      const denied = await fetch(base + file.url, { headers });
      assert.equal(denied.status, nextStatus, await denied.clone().text());
      await denied.arrayBuffer();
    } finally {
      release();
      await pending.catch(() => {});
      await revoking?.catch(() => {});
    }
  };
  const stalledDelivery = async (headers: { Cookie: string }, close: "abort" | "deadline") => {
    let reached!: () => void, release!: () => void;
    const atEnd = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    barrier = { reached, gate };
    const controller = new AbortController();
    const pending = fetch(base + file.url, { headers, signal: controller.signal })
      .then((response) => response.arrayBuffer());
    void pending.catch(() => {});
    let revoking: Promise<unknown> | undefined;
    try {
      await Promise.race([atEnd, until("AI attachment missed stalled-response barrier")]);
      revoking = client.query(`UPDATE archive_memberships SET approved=false
        WHERE archive_id=$1 AND user_id='owner'`, [db.archiveId]);
      const order = await Promise.race([
        revoking.then(() => "completed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 250)),
      ]);
      assert.equal(order, "waiting", "stalled delivery must retain the member lock");
      if (close === "abort") controller.abort();
      await assert.rejects(Promise.race([pending,
        until("Stalled AI attachment response did not close")]));
      await revoking;
    } finally {
      controller.abort();
      release();
      await pending.catch(() => {});
      await revoking?.catch(() => {});
      await client.query(`UPDATE archive_memberships SET approved=true
        WHERE archive_id=$1 AND user_id='owner'`, [db.archiveId]);
    }
  };
  try {
    const active = await session();
    const baseline = await fetch(base + file.url, { headers: active.headers });
    assert.equal(baseline.status, 200, await baseline.clone().text());
    assert.equal(await baseline.text(), sentinel);

    const loggedOut = await session();
    await race(loggedOut.headers,
      () => client.query("DELETE FROM account_sessions WHERE token_hash=$1", [loggedOut.hash]),
      401, true);
    await race(active.headers,
      () => client.query(`UPDATE archive_memberships SET approved=false
        WHERE archive_id=$1 AND user_id='owner'`, [db.archiveId]), 403);
    await client.query(`UPDATE archive_memberships SET approved=true
      WHERE archive_id=$1 AND user_id='owner'`, [db.archiveId]);
    await race(active.headers,
      () => client.query("UPDATE account_tiers SET full_access=false WHERE account_id='owner'"), 403);
    await client.query("UPDATE account_tiers SET full_access=true WHERE account_id='owner'");
    await stalledDelivery(active.headers, "abort");
    await stalledDelivery(active.headers, "deadline");
    const afterClose = await fetch(base + file.url, { headers: active.headers });
    assert.equal(afterClose.status, 200, "a closed response releases its delivery slot");
    assert.equal(await afterClose.text(), sentinel);

    const previousReader = await client.query<{
      role: string; approved: boolean; person_id: string | null; tree_access: string;
    }>(`SELECT role,approved,person_id,tree_access FROM archive_memberships
      WHERE archive_id=$1 AND user_id='reader'`, [db.archiveId]);
    assert.ok(previousReader.rows[0]);
    const previousReaderTier = await client.query<{ full_access: boolean }>(
      "SELECT full_access FROM account_tiers WHERE account_id='reader'");
    const priorRevision = Number((await client.query<{ revision: number }>(
      "SELECT revision FROM archives WHERE id=$1", [db.archiveId])).rows[0].revision);
    let scopedChatId: string | undefined;
    try {
      await client.query(`UPDATE archive_memberships
        SET tree_access='common_ancestors',person_id='person-a'
        WHERE archive_id=$1 AND user_id='reader'`, [db.archiveId]);
      await client.query(`INSERT INTO account_tiers(account_id,full_access)
        VALUES('reader',true) ON CONFLICT(account_id) DO UPDATE SET full_access=true`);
      const scopedUser = await (await userStore(db)).get("reader");
      assert.ok(scopedUser);
      const scopedChat = await chats.create(scopedUser.id,
        aiChatAccessScope(scopedUser, (await archive.read()).family));
      scopedChatId = scopedChat.id;
      const scopedSentinel = "scoped-private-ai-attachment";
      const [scopedFile] = await attachments.save(scopedChat.id, [{
        name: "scoped.txt", type: "text/plain", bytes: Buffer.from(scopedSentinel),
      }]);
      await chats.append(scopedChat.id, "user", "Scoped attachment", {
        attachments: [scopedFile],
      });
      const scopedSession = await session("reader");
      bumpRevisionOnDelivery = true;
      const staleScope = await fetch(base + scopedFile.url,
        { headers: scopedSession.headers });
      assert.equal(staleScope.status, 409,
        "a graph revision change after scope validation must stop private bytes");
      assert.doesNotMatch(await staleScope.text(), /scoped-private-ai-attachment/);
      console.log("runtime_ai_attachment_scope_revision_ok");
    } finally {
      bumpRevisionOnDelivery = false;
      await client.query("UPDATE archives SET revision=$2 WHERE id=$1",
        [db.archiveId, priorRevision]);
      if (scopedChatId) {
        await chats.delete(scopedChatId, "reader");
        await attachments.deleteChat(scopedChatId);
      }
      await client.query(`UPDATE archive_memberships
        SET role=$2,approved=$3,person_id=$4,tree_access=$5
        WHERE archive_id=$1 AND user_id='reader'`, [db.archiveId,
        previousReader.rows[0].role, previousReader.rows[0].approved,
        previousReader.rows[0].person_id, previousReader.rows[0].tree_access]);
      if (previousReaderTier.rows.length)
        await client.query("UPDATE account_tiers SET full_access=$1 WHERE account_id='reader'",
          [previousReaderTier.rows[0].full_access]);
      else await client.query("DELETE FROM account_tiers WHERE account_id='reader'");
    }
    await race(active.headers,
      () => client.query("DELETE FROM ai_chats WHERE id=$1 AND user_id='owner'", [chat.id]),
      404, false, true);
    console.log("runtime_ai_attachment_delivery_revocation_ok");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handler.close();
    await client.query("DELETE FROM account_sessions WHERE token_hash=ANY($1)", [tokens]);
    await client.query(`UPDATE archive_memberships SET approved=true
      WHERE archive_id=$1 AND user_id='owner'`, [db.archiveId]);
    if (previousTier.rows.length)
      await client.query("UPDATE account_tiers SET full_access=$1 WHERE account_id='owner'",
        [previousTier.rows[0].full_access]);
    else await client.query("DELETE FROM account_tiers WHERE account_id='owner'");
    await chats.delete(chat.id, "owner");
    await rm(directory, { recursive: true, force: true });
  }
}
