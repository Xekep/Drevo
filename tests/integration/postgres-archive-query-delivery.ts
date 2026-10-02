import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { fixture, tokens } from "./postgres-fixture.ts";
import { sessionTokenHash } from "../../src/server/session-token.ts";
import { postgresBindings, type StoreDatabase } from "../../src/server/store-database.ts";
import { readPostgresArchive } from "../../src/server/postgres-archive-read.ts";
import { archiveQueryHttp } from "../../src/server/archive-query-http.ts";
import type { openArchive } from "../../src/server/database.ts";
import type { createAuth } from "../../src/server/auth.ts";
import type { settingsStore } from "../../src/server/settings.ts";
import type { treePreferencesStore } from "../../src/server/tree-preferences.ts";
import type { researchCatalogStore } from "../../src/server/research-catalog.ts";

test("prepared archive JSON is withheld after PostgreSQL access or graph changes", async (t) => {
  const { first, second } = await fixture(t);
  await first.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  await second.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  await first.query(`INSERT INTO archive_access_settings(archive_id,public_tree,public_albums)
    VALUES('tree-a',false,false)`);
  await first.query(`UPDATE archive_memberships
    SET tree_access='common_ancestors',person_id='child'
    WHERE archive_id='tree-a' AND user_id='relative'`);

  let inTransaction = false;
  const db = {
    kind: "postgres",
    archiveId: "tree-a",
    inTransaction: () => inTransaction,
    prepare(_sqlite: string, postgres: string) {
      const sql = postgresBindings(postgres);
      return {
        get: async (...values: unknown[]) => (await first.query(sql, values)).rows[0],
        all: async (...values: unknown[]) => (await first.query(sql, values)).rows,
      };
    },
    transaction: async <T>(work: () => Promise<T>) => {
      if (inTransaction) return await work();
      await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      try {
        const result = await work();
        await first.query("COMMIT");
        return result;
      } catch (error) {
        await first.query("ROLLBACK");
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    postgresTransaction: async () => { throw new Error("not used by authenticated requests"); },
  } as unknown as StoreDatabase;

  let pauseRead: { reached: () => void; wait: Promise<void> } | undefined;
  const archive = {
    db,
    read: async () => {
      const snapshot = await readPostgresArchive(first, "tree-a");
      const pause = pauseRead;
      pauseRead = undefined;
      if (pause) {
        pause.reached();
        await pause.wait;
      }
      return snapshot;
    },
  } as unknown as Awaited<ReturnType<typeof openArchive>>;
  const currentUser = async (req: IncomingMessage) => {
    const token = req.headers.cookie?.split("drevo_session=")[1]?.split(";")[0];
    if (!token) return null;
    const row = (await first.query(`SELECT s.user_id,m.role,m.approved,m.person_id,m.tree_access
      FROM account_sessions s JOIN archive_memberships m ON m.user_id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>$2 AND m.archive_id='tree-a'`,
      [sessionTokenHash(token), Date.now()])).rows[0];
    return row ? {
      id: String(row.user_id), name: String(row.user_id),
      role: row.role, approved: row.approved, createdAt: "2026-01-01",
      personId: row.person_id || undefined, treeAccess: row.tree_access,
    } : null;
  };
  const auth = {
    local: false,
    currentUser,
    canRead: async (req: IncomingMessage) => (await currentUser(req))?.approved === true,
    canEdit: async (req: IncomingMessage) => (await currentUser(req))?.approved === true,
    isPlatformAdmin: async () => false,
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const visibility = {
    read: async () => {
      const row = (await first.query(`SELECT public_tree,public_albums
        FROM archive_access_settings WHERE archive_id='tree-a'`)).rows[0];
      return { publicTree: !!row.public_tree, publicAlbums: !!row.public_albums,
        reverseTimeline: false };
    },
  } as Awaited<ReturnType<typeof settingsStore>>;
  const handler = archiveQueryHttp({ archive, auth, visibility,
    treePreferences: { read: async () => null } as unknown as ReturnType<typeof treePreferencesStore>,
    researchCatalog: { list: async () => [] } as unknown as ReturnType<typeof researchCatalogStore>,
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string, token = tokens.relative) => fetch(base + path, {
    headers: { Cookie: `drevo_session=${token}` },
  });

  const unchanged = await get("/api/export.json");
  assert.equal(unchanged.status, 200);
  assert.equal((await unchanged.json()).people.some((person: { id: string }) =>
    person.id === "father"), true, "unchanged scoped access still returns an ancestor");

  async function race(path: string, update: () => Promise<unknown>, token = tokens.relative) {
    let reached!: () => void;
    let resume!: () => void;
    const readReached = new Promise<void>((resolve) => { reached = resolve; });
    const readGate = new Promise<void>((resolve) => { resume = resolve; });
    pauseRead = { reached, wait: readGate };
    const pending = get(path, token);
    let timer!: ReturnType<typeof setTimeout>;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("archive read was not reached")), 10_000);
      });
      await Promise.race([readReached, timeout]);
      await update();
    } finally {
      clearTimeout(timer);
      resume();
    }
    return await pending;
  }

  const staleAdminExport = await race("/api/export.json", async () => {
    await second.query(`UPDATE people SET data=jsonb_set(data,'{name}',
      '"Replaced Name"'::jsonb) WHERE archive_id='tree-a' AND id='father'`);
    await second.query("UPDATE archives SET revision=revision+1 WHERE id='tree-a'");
  }, tokens.admin);
  assert.equal(staleAdminExport.status, 409);
  assert.doesNotMatch(await staleAdminExport.text(), /father/);
  const freshAdminExport = await get("/api/export.json", tokens.admin);
  assert.equal(freshAdminExport.status, 200);
  assert.match(await freshAdminExport.text(), /Replaced Name/);

  const revoked = await race("/api/export.json", () => second.query(`UPDATE archive_memberships
    SET approved=false WHERE archive_id='tree-a' AND user_id='relative'`));
  assert.equal(revoked.status, 409);
  assert.doesNotMatch(await revoked.text(), /father|child/);
  await second.query(`UPDATE archive_memberships SET approved=true
    WHERE archive_id='tree-a' AND user_id='relative'`);

  const changedGraph = await race("/api/export", async () => {
    await second.query(`DELETE FROM relations WHERE archive_id='tree-a'
      AND source='father' AND target='child' AND type='parent'`);
    await second.query("UPDATE archives SET revision=revision+1 WHERE id='tree-a'");
  });
  assert.equal(changedGraph.status, 409);
  assert.doesNotMatch(await changedGraph.text(), /father|child/);
  const afterChange = await get("/api/export.json");
  assert.equal(afterChange.status, 200);
  assert.equal((await afterChange.json()).people.some((person: { id: string }) =>
    person.id === "father"), false, "a fresh scoped request uses the changed graph");

  const loggedOut = await race("/api/export.json", () => second.query(
    "DELETE FROM account_sessions WHERE token_hash=$1",
    [sessionTokenHash(tokens.relative)],
  ));
  assert.equal(loggedOut.status, 409);
  assert.doesNotMatch(await loggedOut.text(), /father|child/);
});
