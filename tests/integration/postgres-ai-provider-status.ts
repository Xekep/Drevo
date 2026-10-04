import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { aiProviderCleanupHttp } from "../../src/server/ai-provider-cleanup-http.ts";
import { aiCleanupStatusSql } from "../../src/server/ai-provider-cleanup-status.ts";
import { createAuth } from "../../src/server/auth.ts";
import { userStore } from "../../src/server/users.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../../src/server/session-token.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import type { AiCleanupStatus } from "../../src/shared/ai-provider-cleanup-status.ts";

export async function verifyAiProviderCleanupStatus(
  db: StoreDatabase,
  base: string,
  ownerHeaders: Record<string, string>,
  readerHeaders: Record<string, string>,
) {
  const path = "/api/admin/ai/cleanup";
  const previousGrant = await db.prepare("", "SELECT account_id FROM platform_admins WHERE account_id='owner'").get();
  if (!previousGrant) {
    assert.equal((await fetch(base + path, { headers: ownerHeaders })).status, 403,
      "being the archive owner does not grant access to platform cleanup");
    await db.prepare("", "INSERT INTO platform_admins(account_id) VALUES('owner')").run();
  }
  const initialResponse = await fetch(base + path, { headers: ownerHeaders });
  assert.equal(initialResponse.status, 200, "platform cleanup status uses the archive pool's JSON parser");
  const initial = (await initialResponse.json()) as AiCleanupStatus;
  assert.equal(initial.supported, true);
  const ids: string[] = [];
  const inputFileId = randomUUID();
  const stamp = Date.now() + 3_600_000;
  const states = ["binding", "pending", "leased", "blocked"] as const;
  const token = newSessionToken();
  const hash = sessionTokenHash(token);
  const adminHeaders = { Cookie: `drevo_session=${token}` };
  await db
    .prepare(
      "",
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'owner',?)",
    )
    .run(hash, Date.now() + 600_000);
  let revoke: "none" | "grant" | "membership" | "session" = "none";
  const auth = await createAuth(
    await userStore(db),
    db,
    "https://archive.test",
  );
  const handle = aiProviderCleanupHttp({
    auth,
    db,
    beforeAccessLock: async () => {
      if (revoke === "grant")
        await db
          .prepare("", "DELETE FROM platform_admins WHERE account_id='owner'")
          .run();
      if (revoke === "session")
        await db
          .prepare("", "DELETE FROM account_sessions WHERE token_hash=?")
          .run(hash);
      if (revoke === "membership")
        await db.prepare("", "UPDATE archive_memberships SET approved=false WHERE user_id='owner'").run();
    },
  });
  const server = createServer((req, res) => {
    void handle(req, res, new URL(req.url!, "http://localhost")).catch(() =>
      res.destroy(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const direct = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (let index = 0; index < 27; index++) {
      const id = randomUUID();
      ids.push(id);
      await db
        .prepare(
          "",
          `INSERT INTO platform_ai_conversations
        (id,key_version,encrypted_snapshot,archive_id,local_chat_id,state,available_at,
          lease_until,attempts,last_error,created_at,updated_at)
        VALUES(?,1,'private-ciphertext-marker','private-archive-marker','private-chat-marker',?,?,?,3,?,?,?)`,
        )
        .run(
          id,
          states[index % 4],
          stamp,
          index % 4 === 3 ? null : stamp,
          index === 3
            ? "provider_auth_403"
            : index === 7
              ? "provider_http_503"
              : "private-provider-error-marker",
          stamp,
          stamp,
        );
    }
    await db.prepare("", `INSERT INTO platform_ai_input_files
      (id,key_version,encrypted_snapshot,state,last_error,available_at,created_at,updated_at)
      VALUES(?,1,'private-file-id-and-key','blocked','provider_auth_403',?,?,?)`)
      .run(inputFileId, stamp - 1, stamp - 1, stamp - 1);
    const response = await fetch(base + path, { headers: ownerHeaders });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(
      text,
      /private-|encrypted_snapshot|local_chat_id|archive_id|lease_token|last_error/,
    );
    const first = JSON.parse(text) as AiCleanupStatus;
    assert.equal(first.jobs.length, 20);
    assert.ok(first.nextCursor);
    const second = (await fetch(base + path + `?cursor=${first.nextCursor}`, {
      headers: ownerHeaders,
    }).then((r) => r.json())) as AiCleanupStatus;
    const selected = [...first.jobs, ...second.jobs].filter((job) =>
      ids.includes(job.id),
    );
    assert.equal(selected.length, 27);
    const file = [...first.jobs, ...second.jobs].find((job) => job.id === inputFileId);
    assert.equal(file?.kind, "input_file");
    assert.equal(file?.state, "blocked");
    assert.equal(file?.canRetry, false);
    assert.doesNotMatch(JSON.stringify([first, second]), /private-file-id-and-key/);
    assert.equal(
      new Set(selected.map((job) => job.id)).size,
      27,
      "equal timestamps paginate by UUID without omissions or repeats",
    );
    assert.equal(first.counts.blocked, initial.counts.blocked + 7);
    assert.equal(
      selected.find((job) => job.id === ids[3])?.error,
      "provider_auth",
    );
    assert.equal(selected.find((job) => job.id === ids[3])?.httpStatus, 403);
    assert.equal(selected.find((job) => job.id === ids[3])?.canRetry, true);
    assert.equal(
      selected.find((job) => job.id === ids[7])?.error,
      "provider_temporary",
    );
    assert.equal(selected.find((job) => job.id === ids[7])?.canRetry, false);
    const blocked = (await fetch(base + path + "?filter=blocked", {
      headers: ownerHeaders,
    }).then((r) => r.json())) as AiCleanupStatus;
    assert.ok(blocked.jobs.every((job) => job.state === "blocked"));
    assert.equal(
      (
        await fetch(
          base + path + `?filter=blocked&cursor=${first.nextCursor}`,
          { headers: ownerHeaders },
        )
      ).status,
      400,
    );
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal(
      (await fetch(base + path, { headers: readerHeaders })).status,
      403,
    );

    revoke = "grant";
    const lostGrant = await fetch(direct + path, { headers: adminHeaders });
    assert.equal(lostGrant.status, 403);
    assert.equal(
      "jobs" in (await lostGrant.json()),
      false,
      "a grant revoked after initial authentication cannot receive platform jobs",
    );
    await db
      .prepare(
        "",
        "INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING",
      )
      .run();
    revoke = "membership";
    const lostMembership = await fetch(direct + path, { headers: adminHeaders });
    assert.equal(lostMembership.status, 403);
    assert.equal("jobs" in (await lostMembership.json()), false);
    await db.prepare("", "UPDATE archive_memberships SET approved=true WHERE user_id='owner'").run();
    revoke = "session";
    const lostSession = await fetch(direct + path, { headers: adminHeaders });
    assert.equal(lostSession.status, 401);
    assert.equal("jobs" in (await lostSession.json()), false);

    await db.postgresTransaction!(async (client) => {
      await client.query("SET LOCAL enable_seqscan=off");
      for (const [condition,index] of [
        ["state='blocked'", "platform_ai_conversations_blocked_status"],
        ["state IN ('binding','pending','leased','blocked')", "platform_ai_conversations_status"],
      ]) {
        const plan = await client.query(`EXPLAIN (FORMAT JSON) SELECT id,updated_at
          FROM public.platform_ai_conversations WHERE ${condition}
          ORDER BY updated_at DESC,id DESC LIMIT 21`);
        const text = JSON.stringify(plan.rows);
        assert.ok(text.includes(index) ||
          (condition === "state='blocked'" &&
            text.includes("platform_ai_conversations_status")),
        "each filter uses an ordered page index (the general index also orders a small blocked page)");
        assert.doesNotMatch(text, /"Node Type":"Sort"/,
          "the page must not sort the complete unfinished queue");
      }
      const filePlan = await client.query(`EXPLAIN (FORMAT JSON)
        SELECT id,updated_at FROM public.platform_ai_input_files
        WHERE state IN ('binding','pending','leased','blocked')
        ORDER BY updated_at DESC,id DESC LIMIT 21`);
      const fileText = JSON.stringify(filePlan.rows);
      assert.match(fileText, /platform_ai_input_files_status/);
      assert.doesNotMatch(fileText, /"Node Type":"Sort"/);
      // Verify the actual combined endpoint query, not only each table in
      // isolation. Historical completed rows must stay outside its page plan.
      await client.query("SAVEPOINT cleanup_status_plan");
      try {
        await client.query(`INSERT INTO public.platform_ai_conversations
          (id,key_version,encrypted_snapshot,archive_id,local_chat_id,state,
            available_at,created_at,updated_at)
          SELECT md5('conversation-status-plan-'||n)::uuid,1,NULL,
            'private-archive','private-chat','done',0,0,0
          FROM generate_series(1,2000) n`);
        await client.query(`INSERT INTO public.platform_ai_input_files
          (id,key_version,encrypted_snapshot,state,available_at,created_at,updated_at)
          SELECT md5('file-status-plan-'||n)::uuid,1,NULL,'done',0,0,0
          FROM generate_series(1,2000) n`);
        const combined = await client.query(`EXPLAIN (ANALYZE,FORMAT JSON)
          ${aiCleanupStatusSql}`, ["all", null, null]);
        const rawCombined = combined.rows[0]["QUERY PLAN"];
        const plan = (typeof rawCombined === "string" ? JSON.parse(rawCombined) : rawCombined)[0].Plan as {
          "Node Type": string; "Relation Name"?: string; "Index Name"?: string;
          "Actual Rows"?: number; Plans?: Array<unknown>;
        };
        const pageIndexes = new Set<string>();
        const walk = (node: typeof plan, limited = false) => {
          const onPage = limited || node["Node Type"] === "Limit";
          if (node["Node Type"] === "Limit")
            assert.ok(Number(node["Actual Rows"]) <= 21,
              "each table contributes no more than one bounded page");
          if (onPage && node["Index Name"])
            pageIndexes.add(node["Index Name"]);
          if (onPage && node["Relation Name"] &&
              ["platform_ai_conversations", "platform_ai_input_files"]
                .includes(node["Relation Name"])) {
            assert.notEqual(node["Node Type"], "Seq Scan",
              "the page must not scan historical completed jobs");
          }
          for (const child of node.Plans || []) walk(child as typeof plan, onPage);
        };
        walk(plan);
        assert.ok(pageIndexes.has("platform_ai_conversations_status"));
        assert.ok(pageIndexes.has("platform_ai_input_files_status"));
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT cleanup_status_plan");
        await client.query("RELEASE SAVEPOINT cleanup_status_plan");
      }
      await client.query("SAVEPOINT cleanup_blocked_plan");
      try {
        await client.query(`INSERT INTO public.platform_ai_input_files
          (id,key_version,encrypted_snapshot,state,available_at,created_at,updated_at)
          SELECT md5('file-pending-plan-'||n)::uuid,1,'synthetic-ciphertext',
            'pending',0,0,$1 FROM generate_series(1,2000) n`, [stamp + 1000]);
        await client.query(`INSERT INTO public.platform_ai_input_files
          (id,key_version,encrypted_snapshot,state,available_at,created_at,updated_at)
          VALUES(md5('file-blocked-plan')::uuid,1,'synthetic-ciphertext',
            'blocked',0,0,$1)`, [stamp - 1000]);
        const blockedPlan = await client.query(`EXPLAIN (ANALYZE,FORMAT JSON)
          ${aiCleanupStatusSql}`, ["blocked", null, null]);
        const indexes: string[] = [];
        const collect = (node: { "Node Type": string; "Index Name"?: string;
          Plans?: Array<unknown> }, limited = false): void => {
          const onPage = limited || node["Node Type"] === "Limit";
          if (onPage && node["Index Name"]) indexes.push(node["Index Name"]);
          for (const child of node.Plans || []) collect(child as typeof node, onPage);
        };
        const rawBlocked = blockedPlan.rows[0]["QUERY PLAN"];
        collect((typeof rawBlocked === "string" ? JSON.parse(rawBlocked) : rawBlocked)[0].Plan);
        assert.ok(indexes.includes("platform_ai_input_files_blocked_status"),
          "blocked page skips a large newer pending backlog");
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT cleanup_blocked_plan");
        await client.query("RELEASE SAVEPOINT cleanup_blocked_plan");
      }
    });
    console.log("runtime_ai_provider_status_privacy_pagination_revocation_ok");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db
      .prepare(
        "",
        "INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING",
      )
      .run();
    await db
      .prepare("", "DELETE FROM account_sessions WHERE token_hash=?")
      .run(hash);
    await db.prepare("", "UPDATE archive_memberships SET approved=true WHERE user_id='owner'").run();
    for (const id of ids)
      await db
        .prepare("", "DELETE FROM platform_ai_conversations WHERE id=?")
        .run(id);
    await db.prepare("", "DELETE FROM platform_ai_input_files WHERE id=?").run(inputFileId);
    if (!previousGrant)
      await db.prepare("", "DELETE FROM platform_admins WHERE account_id='owner'").run();
  }
}
