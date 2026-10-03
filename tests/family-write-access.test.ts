import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { startServer } from "../src/server/index.ts";
import { userStore } from "../src/server/users.ts";
import { createAuth } from "../src/server/auth.ts";
import { familyChangesHttp } from "../src/server/family-changes-http.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../src/server/session-token.ts";

test("SQLite rechecks session and membership after the HTTP snapshot, before both write paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-write-access-"));
  const app = await startServer(0, join(directory, "drevo.sqlite"), true);
  try {
    const users = await userStore(app.archive.db);
    await users.register("access-test", "Тест");
    const origin = "http://write-check.invalid",
      auth = await createAuth(users, app.archive.db, origin);
    for (const full of [true, false])
      for (const sessionRevoked of [true, false]) {
        await app.archive.db
          .prepare(
            "UPDATE users SET role='admin',approved=1 WHERE id='access-test'",
          )
          .run();
        const token = newSessionToken(),
          hash = sessionTokenHash(token);
        await app.archive.db
          .prepare(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
          )
          .run(hash, "access-test", Date.now() + 60_000);
        const before = await app.archive.read();
        const endpoint = familyChangesHttp({
          archive: app.archive,
          auth,
          publicOrigin: origin,
          beforeMutation: async () => {
            if (sessionRevoked)
              await app.archive.db
                .prepare("DELETE FROM auth_sessions WHERE token_hash=?")
                .run(hash);
            else
              await app.archive.db
                .prepare("UPDATE users SET approved=0 WHERE id='access-test'")
                .run();
          },
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
          const response = await fetch(
            `http://127.0.0.1:${(server.address() as { port: number }).port}/api/family${full ? "" : "/changes"}`,
            {
              method: full ? "PUT" : "POST",
              headers: {
                Origin: origin,
                Cookie: `drevo_session=${token}`,
                "Content-Type": "application/json",
                "If-Match": String(before.revision),
              },
              body: JSON.stringify(
                full
                  ? { ...before.family, title: "Новая запись" }
                  : {
                      changes: [
                        {
                          collection: "meta",
                          field: "title",
                          before: before.family.title,
                          after: "Новая запись",
                        },
                      ],
                    },
              ),
            },
          );
          assert.equal(response.status, sessionRevoked ? 401 : 403);
          assert.doesNotMatch(
            await response.text(),
            /"family"|"appliedChanges"/,
          );
          assert.deepEqual(await app.archive.read(), before);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
