import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { archiveQueryHttp } from "../src/server/archive-query-http.ts";
import { storeDatabase } from "../src/server/store-database.ts";
import type { openArchive } from "../src/server/database.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { settingsStore } from "../src/server/settings.ts";
import type { treePreferencesStore } from "../src/server/tree-preferences.ts";
import type { researchCatalogStore } from "../src/server/research-catalog.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

test("account portrait returns only the current member's linked image without reading the family", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE archive(id INTEGER PRIMARY KEY, revision INTEGER);
    INSERT INTO archive VALUES(1,1);
    CREATE TABLE people(id TEXT PRIMARY KEY, data TEXT);
    INSERT INTO people VALUES('self','{"photo":"/media/self.jpg","biography":"private"}'),
      ('other','{"photo":"/media/other.jpg"}');`);
  const db = storeDatabase(sqlite);
  let actor: ArchiveUser | null = { id: "reader", name: "Reader", role: "reader",
    approved: true, personId: "self", createdAt: "2026-01-01", treeAccess: "common_ancestors" };
  let afterRead: (() => void) | undefined;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql, postgres) => {
    const statement = prepare(sql, postgres);
    if (!sql.includes("AS photo")) return statement;
    return { ...statement, get: async (...args) => {
      const row = await statement.get(...args);
      const action = afterRead;
      afterRead = undefined;
      action?.();
      return row;
    } };
  };
  const handler = archiveQueryHttp({
    archive: { db, read: async () => { throw new Error("Full graph must not be read"); } } as unknown as Awaited<ReturnType<typeof openArchive>>,
    auth: { local: false, currentUser: async () => actor } as unknown as Awaited<ReturnType<typeof createAuth>>,
    visibility: { read: async () => ({ publicTree: true, publicAlbums: true }) } as Awaited<ReturnType<typeof settingsStore>>,
    treePreferences: {} as ReturnType<typeof treePreferencesStore>,
    researchCatalog: {} as ReturnType<typeof researchCatalogStore>,
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://localhost"))
      .catch((error) => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sqlite.close();
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/account/portrait`;
  const own = await fetch(url + "?personId=other");
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await own.json(), { personId: "self", photo: "/media/self.jpg" });
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  const member = actor;
  actor = { ...member, approved: false };
  assert.equal((await fetch(url)).status, 401);
  actor = null;
  assert.equal((await fetch(url)).status, 401, "public viewing does not disclose an account portrait");
  actor = { ...member, personId: undefined };
  assert.deepEqual(await (await fetch(url)).json(), { personId: null, photo: null });
  actor = { ...member, personId: "deleted" };
  assert.deepEqual(await (await fetch(url)).json(), { personId: "deleted", photo: null });
  for (const change of [
    () => { actor = { ...member, approved: false }; },
    () => { actor = { ...member, personId: "other" }; },
    () => { actor = null; },
    () => { sqlite.exec("UPDATE archive SET revision=revision+1 WHERE id=1"); },
  ]) {
    actor = member;
    afterRead = change;
    const changed = await fetch(url);
    assert.equal(changed.status, 409);
    assert.doesNotMatch(await changed.text(), /self\.jpg|other\.jpg|private/);
  }
});
