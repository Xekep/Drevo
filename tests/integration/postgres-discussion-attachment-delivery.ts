import assert from "node:assert/strict";
import { rmdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Client } from "pg";
import { createAuth } from "../../src/server/auth.ts";
import type { openArchive } from "../../src/server/database.ts";
import { discussionAttachmentStore, prepareCommentFile } from "../../src/server/discussion-attachments.ts";
import { mediaStore } from "../../src/server/media.ts";
import { personDiscussionHttp } from "../../src/server/person-discussion-http.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { userStore } from "../../src/server/users.ts";

function gate() {
  let reached!: () => void;
  let release!: () => void;
  return {
    ready: new Promise<void>((resolve) => { reached = resolve; }),
    wait: new Promise<void>((resolve) => { release = resolve; }),
    reached: () => reached(),
    release: () => release(),
  };
}

async function within<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 10_000);
      timer.unref();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function verifyDiscussionAttachmentDelivery(
  archive: Awaited<ReturnType<typeof openArchive>>,
  client: Client,
  uploadsDirectory: string,
) {
  const archiveId = archive.db.archiveId;
  const accountId = "discussion-delivery-reader";
  const token = newSessionToken();
  const tokenHash = sessionTokenHash(token);
  const headers = { Cookie: `drevo_session=${token}` };
  const bytes = Buffer.from("private-discussion-attachment");
  const store = discussionAttachmentStore(uploadsDirectory);
  const [file] = await store.save([await prepareCommentFile("private.txt", bytes)]);
  const oldContext = (await client.query<{ value: string | null }>(
    "SELECT current_setting('drevo.archive_id',true) AS value",
  )).rows[0].value;
  await client.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
  let commentId: number | undefined;
  const servers: Array<ReturnType<typeof createServer>> = [];
  const auth = await createAuth(await userStore(archive.db), archive.db,
    "https://discussion-delivery.invalid");
  const serve = async (hooks: {
    beforeAttachmentDelivery?: () => Promise<void>;
    beforeLockedAttachmentDelivery?: () => Promise<void>;
    afterAttachmentAccessCheck?: () => Promise<void>;
  } = {}) => {
    const handler = personDiscussionHttp({ archive, auth, media: mediaStore(uploadsDirectory),
      uploadsDirectory, ...hooks });
    const server = createServer((req, res) => {
      void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .then((handled) => { if (!handled) res.writeHead(404).end(); })
        .catch((error) => res.destroy(error));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  try {
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Attachment reader',$2)",
      [accountId, new Date().toISOString()]);
    await client.query(
      `INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
       VALUES($1,$2,'reader',true,'all')`, [archiveId, accountId]);
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [tokenHash, accountId, Date.now() + 60_000]);
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text,attachments)
       VALUES('person-a','owner','Owner',$1,'Attachment delivery probe',$2::jsonb)
       RETURNING id`, [Date.now(), JSON.stringify([file])]);
    commentId = Number(inserted.rows[0].id);
    const path = `/api/people/person-a/discussion/${commentId}/attachments/${file.id}`;
    const base = await serve();
    const initial = await fetch(base + path, { headers });
    assert.equal(initial.status, 200);
    assert.deepEqual(Buffer.from(await initial.arrayBuffer()), bytes);
    const parallel = await within(Promise.all(Array.from({ length: 12 }, async () => {
      const response = await fetch(base + path, { headers });
      return [response.status, Buffer.from(await response.arrayBuffer()).equals(bytes)];
    })), "Parallel attachment downloads exhausted the PostgreSQL pool");
    assert.ok(parallel.every(([status, same]) => status === 200 && same === true));

    await client.query(
      "UPDATE archive_memberships SET tree_access='common_ancestors',person_id='person-a' WHERE archive_id=$1 AND user_id=$2",
      [archiveId, accountId]);
    const scopedControl = await fetch(base + path, { headers });
    assert.equal(scopedControl.status, 200);
    await scopedControl.arrayBuffer();
    const changedGraph = gate();
    const graphServer = await serve({ afterAttachmentAccessCheck: async () => {
      changedGraph.reached(); await changedGraph.wait;
    } });
    const staleGraph = fetch(graphServer + path, { headers });
    let previousRevision: number | undefined;
    try {
      await within(changedGraph.ready, "Scoped attachment visibility barrier missed");
      // A graph write can remove a common-ancestor path without changing the
      // membership tuple or the comment. Its revision must invalidate the
      // visibility snapshot captured by checkCurrentAccess.
      previousRevision = Number((await client.query<{ revision: string }>(
        "SELECT revision FROM archives WHERE id=$1", [archiveId],
      )).rows[0].revision);
      await client.query("UPDATE archives SET revision=revision+1 WHERE id=$1", [archiveId]);
      changedGraph.release();
      const response = await within(staleGraph, "Scoped attachment graph race hung");
      assert.equal(response.status, 404,
        "a graph revision after scoped visibility calculation must reject stale access");
      assert.notDeepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    } finally {
      changedGraph.release();
      if (previousRevision !== undefined)
        await client.query("UPDATE archives SET revision=$2 WHERE id=$1",
          [archiveId, previousRevision]);
      await client.query(
        "UPDATE archive_memberships SET tree_access='all',person_id=NULL WHERE archive_id=$1 AND user_id=$2",
        [archiveId, accountId]);
    }

    for (const kind of ["session", "membership"] as const) {
      const pause = gate();
      const staged = await serve({ beforeAttachmentDelivery: async () => {
        pause.reached(); await pause.wait;
      } });
      const pending = fetch(staged + path, { headers });
      try {
        await within(pause.ready, `Attachment ${kind} barrier missed`);
        if (kind === "session")
          await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [tokenHash]);
        else
          await client.query(
            "UPDATE archive_memberships SET approved=false WHERE archive_id=$1 AND user_id=$2",
            [archiveId, accountId]);
        pause.release();
        const response = await within(pending, `Attachment ${kind} delivery hung`);
        assert.notEqual(response.status, 200,
          `a completed ${kind} revoke must prevent attachment delivery`);
        assert.notDeepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      } finally {
        pause.release();
        if (kind === "session")
          await client.query(
            "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
            [tokenHash, accountId, Date.now() + 60_000]);
        else
          await client.query(
            "UPDATE archive_memberships SET approved=true WHERE archive_id=$1 AND user_id=$2",
            [archiveId, accountId]);
      }
    }

    const pause = gate();
    const locked = await serve({ beforeLockedAttachmentDelivery: async () => {
      pause.reached(); await pause.wait;
    } });
    const pending = fetch(locked + path, { headers });
    let revoke: Promise<unknown> | undefined;
    try {
      await within(pause.ready, "Locked attachment delivery barrier missed");
      revoke = client.query(
        "UPDATE archive_memberships SET approved=false WHERE archive_id=$1 AND user_id=$2",
        [archiveId, accountId]);
      assert.equal(await Promise.race([
        revoke.then(() => "completed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 250)),
      ]), "waiting", "membership revoke must wait until attachment handoff");
      pause.release();
      const response = await within(pending, "Locked attachment delivery hung");
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      await revoke;
      const rejected = await fetch(base + path, { headers });
      assert.equal(rejected.status, 401);
      await rejected.arrayBuffer();
    } finally {
      pause.release();
      await revoke?.catch(() => {});
      await client.query(
        "UPDATE archive_memberships SET approved=true WHERE archive_id=$1 AND user_id=$2",
        [archiveId, accountId]);
    }
    const removed = gate();
    const removing = await serve({ beforeAttachmentDelivery: async () => {
      removed.reached(); await removed.wait;
    } });
    const stale = fetch(removing + path, { headers });
    try {
      await within(removed.ready, "Removed attachment delivery barrier missed");
      await client.query("UPDATE person_comments SET attachments='[]'::jsonb WHERE id=$1",
        [commentId]);
      removed.release();
      const response = await within(stale, "Removed attachment delivery hung");
      assert.equal(response.status, 404,
        "a removed comment attachment cannot be delivered from an old metadata snapshot");
      assert.notDeepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    } finally {
      removed.release();
    }
    console.log("postgres_discussion_attachment_delivery_verified");
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (commentId !== undefined)
      await client.query("DELETE FROM person_comments WHERE id=$1", [commentId]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [tokenHash]);
    await client.query("DELETE FROM archive_memberships WHERE archive_id=$1 AND user_id=$2",
      [archiveId, accountId]);
    await client.query("DELETE FROM accounts WHERE id=$1", [accountId]);
    await store.remove([file]);
    // The next runtime case backs up uploads. Do not leave this case's empty
    // private directory in that fixture.
    await rmdir(join(uploadsDirectory, "discussion-files"));
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [oldContext || ""]);
  }
}
