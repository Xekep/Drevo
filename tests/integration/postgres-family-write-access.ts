import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type pg from "pg";
import type { openArchive } from "../../src/server/database.ts";
import { createAuth } from "../../src/server/auth.ts";
import { userStore } from "../../src/server/users.ts";
import { familyChangesHttp } from "../../src/server/family-changes-http.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../../src/server/session-token.ts";
import { openPostgresDatabase } from "../../src/server/store-database.ts";
import { mcpTokenStore } from "../../src/server/mcp-tokens.ts";
import {
  mcpUsageStore,
  McpRateLimitError,
} from "../../src/server/mcp-usage.ts";

export async function verifyFamilyWriteAccess(
  archive: Awaited<ReturnType<typeof openArchive>>,
  client: pg.Client,
) {
  const users = await userStore(archive.db),
    actor = (await users.get("owner"))!;
  const origin = process.env.PUBLIC_ORIGIN!,
    auth = await createAuth(users, archive.db, origin);
  const original = await archive.read(),
    person = original.family.people[0];
  assert.ok(person);
  for (const mode of [
    "revoked-before-save",
    "scope-before-save",
    "revoked-before-delivery",
  ] as const) {
    const token = newSessionToken(),
      hash = sessionTokenHash(token);
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
      [hash, Date.now() + 60_000],
    );
    const changeAccess = async () => {
      if (mode === "scope-before-save")
        await client.query(
          "UPDATE archive_memberships SET approved=false WHERE archive_id=$1 AND user_id='owner'",
          [archive.db.archiveId],
        );
      else
        await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [
          hash,
        ]);
    };
    const endpoint = familyChangesHttp({
      archive,
      auth,
      publicOrigin: origin,
      ...(mode === "revoked-before-delivery"
        ? { beforeDelivery: changeAccess }
        : { beforeMutation: changeAccess }),
    });
    const server = createServer((req, res) => {
      void endpoint(req, res, new URL(req.url!, "http://localhost")).catch(
        () => {
          res.writeHead(500).end();
        },
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const before = await archive.read(),
        biography = `Isolated access check ${randomUUID()}`;
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/api/family/changes`,
        {
          method: "POST",
          headers: {
            Origin: origin,
            Cookie: `drevo_session=${token}`,
            "Content-Type": "application/json",
            "If-Match": String(before.revision),
          },
          body: JSON.stringify({
            changes: [
              {
                collection: "people",
                id: person.id,
                field: "biography",
                before: before.family.people[0].biography,
                after: biography,
              },
            ],
          }),
        },
      );
      assert.equal(response.status, mode === "scope-before-save" ? 403 : 401);
      assert.doesNotMatch(await response.text(), /"family"|"appliedChanges"/);
      const after = await archive.read();
      if (mode === "revoked-before-delivery")
        assert.equal(after.family.people[0].biography, biography);
      else
        assert.deepEqual(
          after,
          before,
          "revocation before the transaction leaves data untouched",
        );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [
        hash,
      ]);
      await client.query(
        "UPDATE archive_memberships SET approved=true WHERE archive_id=$1 AND user_id='owner'",
        [archive.db.archiveId],
      );
      await archive.write(original.family, (await archive.meta()).revision);
    }
  }
  const second = await openPostgresDatabase(
    archive.db.archiveId!,
    archive.db.file,
  );
  const issued = await mcpTokenStore(archive.db).issue(actor, {
    name: "Isolated budget check",
    scopes: ["tree:read"],
    rateLimitPerMinute: 5,
  });
  try {
    const stores = [mcpUsageStore(archive.db), mcpUsageStore(second)];
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        stores[index % 2].begin(issued.item.id, "tools/list", undefined, 5),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      5,
    );
    for (const result of results)
      if (result.status === "rejected")
        assert.ok(result.reason instanceof McpRateLimitError);
    assert.equal((await stores[0].tokenSummary(issued.item.id)).callsToday, 5);
  } finally {
    await second.close();
    await archive.db.transaction(async () => {
      await archive.db
        .prepare(
          "DELETE FROM mcp_usage WHERE token_id=?",
          "DELETE FROM mcp_usage WHERE token_id=?",
        )
        .run(issued.item.id);
      await archive.db
        .prepare(
          "DELETE FROM mcp_tokens WHERE id=?",
          "DELETE FROM mcp_tokens WHERE id=?",
        )
        .run(issued.item.id);
    });
  }
}
