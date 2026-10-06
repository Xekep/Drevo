import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { fixture, tokens, person } from "./postgres-fixture.ts";
import { sessionTokenHash } from "../../src/server/session-token.ts";
import { postgresBindings, type StoreDatabase } from "../../src/server/store-database.ts";
import { readPostgresArchive } from "../../src/server/postgres-archive-read.ts";
import { archiveQueryHttp } from "../../src/server/archive-query-http.ts";
import { archiveOverview } from "../../src/domain/archive-projection.ts";
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
  for (const [ordinal, id] of [[3, "partner"], [4, "partner-parent"],
    [5, "partner-other-spouse"]] as const)
    await first.query(`INSERT INTO people(archive_id,id,ordinal,data)
      VALUES('tree-a',$1,$2,$3::jsonb)`, [id, ordinal,
      JSON.stringify(person(id, "1980"))]);
  await first.query(`INSERT INTO relations(archive_id,id,source,target,type,ordinal)
    VALUES('tree-a','blood-partner','child','partner','spouse',10),
          ('tree-a','partner-parent','partner-parent','partner','parent',11),
          ('tree-a','partner-other-spouse','partner','partner-other-spouse','spouse',12)`);
  for (const [ordinal, id, birth] of [[6, "descendant", "2000"], [7, "co-parent", "1980"],
    [8, "co-grandparent", "1950"], [9, "co-sibling", "1985"], [10, "co-other", "1980"]] as const)
    await first.query(`INSERT INTO people(archive_id,id,ordinal,data)
      VALUES('tree-a',$1,$2,$3::jsonb)`, [id, ordinal, JSON.stringify(person(id, birth))]);
  await first.query(`INSERT INTO relations(archive_id,id,source,target,type,ordinal)
    VALUES('tree-a','descendant-parent','child','descendant','parent',13),
          ('tree-a','descendant-coparent','co-parent','descendant','parent',14),
          ('tree-a','coparent-ancestor','co-grandparent','co-parent','parent',15),
          ('tree-a','coparent-sibling','co-grandparent','co-sibling','parent',16),
          ('tree-a','coparent-other-union','co-parent','co-other','spouse',17)`);
  await first.query(`CREATE TABLE request_rate_limits (
    scope text NOT NULL, key_hash text NOT NULL, started_at bigint NOT NULL,
    attempts integer NOT NULL, PRIMARY KEY(scope,key_hash))`);

  let inTransaction = false;
  const db = {
    kind: "postgres",
    archiveId: "tree-a",
    inTransaction: () => inTransaction,
    prepare(_sqlite: string, postgres: string) {
      const sql = postgresBindings(postgres);
      return {
        get: async (...values: unknown[]) => (await first.query(sql, values)).rows[0],
        all: async (...values: unknown[]) => (await first.query(sql, values)).rows.map(
          (row) => row.data && typeof row.data === "object"
            ? { ...row, data: JSON.stringify(row.data) } : row),
      };
    },
    transaction: async <T>(work: () => Promise<T>, readOnly = false) => {
      if (inTransaction) return await work();
      await first.query(`BEGIN ISOLATION LEVEL REPEATABLE READ ${readOnly ? "READ ONLY" : "READ WRITE"}`);
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
    postgresTransaction: async <T>(work: (client: typeof second) => Promise<T>) => {
      await second.query("BEGIN");
      try {
        const value = await work(second);
        await second.query("COMMIT");
        return value;
      } catch (error) {
        await second.query("ROLLBACK");
        throw error;
      }
    },
  } as unknown as StoreDatabase;

  let pauseRead: { reached: () => void; wait: Promise<void> } | undefined;
  let pauseDelivery: { reached: () => void; wait: Promise<void> } | undefined;
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
    overview: async () => {
      const snapshot = await archive.read();
      return { family: archiveOverview(snapshot.family), revision: snapshot.revision,
        totals: { people: snapshot.family.people.length, photos: snapshot.family.photos?.length || 0 } };
    },
    meta: async () => {
      const snapshot = await readPostgresArchive(first, "tree-a");
      return { revision: snapshot.revision, people: snapshot.family.people.length,
        photos: snapshot.family.photos?.length || 0 };
    },
    peoplePage: async (offset: number, limit: number) =>
      (await archive.read()).family.people.slice(offset, offset + limit),
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
    accountSession: async (req: IncomingMessage) => {
      const token = req.headers.cookie?.split("drevo_session=")[1]?.split(";")[0];
      if (!token) return null;
      const tokenHash = sessionTokenHash(token);
      const row = (await first.query(`SELECT user_id FROM account_sessions
        WHERE token_hash=$1 AND expires_at>$2`, [tokenHash, Date.now()])).rows[0];
      return row ? { accountId: String(row.user_id), tokenHash } : null;
    },
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
    beforeDelivery: async () => {
      const pause = pauseDelivery;
      pauseDelivery = undefined;
      if (pause) { pause.reached(); await pause.wait; }
    },
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

  await first.query(`UPDATE people SET data=jsonb_set(data,'{photo}',
    '"/media/self.jpg"'::jsonb) WHERE archive_id='tree-a' AND id='child'`);
  const portrait = await get("/api/account/portrait?personId=father");
  assert.equal(portrait.status, 200);
  assert.deepEqual(await portrait.json(), { personId: "child", photo: "/media/self.jpg" });
  assert.equal((await get("/api/account/portrait", "")).status, 401);
  for (const update of [
    () => second.query(`UPDATE archive_memberships SET person_id=NULL
      WHERE archive_id='tree-a' AND user_id='relative'`),
    () => second.query(`UPDATE archive_memberships SET approved=false
      WHERE archive_id='tree-a' AND user_id='relative'`),
    () => second.query("UPDATE archives SET revision=revision+1 WHERE id='tree-a'"),
  ]) {
    let reached!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const wait = new Promise<void>((resolve) => { resume = resolve; });
    pauseDelivery = { reached, wait };
    const pending = get("/api/account/portrait");
    let timer!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("portrait delivery not reached")), 10_000);
      })]);
      await update();
    } finally { clearTimeout(timer); resume(); }
    const stale = await pending;
    assert.equal(stale.status, 409);
    assert.doesNotMatch(await stale.text(), /self\.jpg/);
    await second.query(`UPDATE archive_memberships SET person_id='child',approved=true
      WHERE archive_id='tree-a' AND user_id='relative'`);
  }

  const unchanged = await get("/api/export.json");
  assert.equal(unchanged.status, 200);
  const unchangedPeople = (await unchanged.json()).people as Array<{ id: string;
    parents: string[]; spouses: string[] }>;
  assert.equal(unchangedPeople.some((person) =>
    person.id === "father"), true, "unchanged scoped access still returns an ancestor");
  const visiblePartner = unchangedPeople.find((person) => person.id === "partner");
  assert.ok(visiblePartner, "a recorded spouse of a blood relative is visible");
  assert.deepEqual(visiblePartner.parents, [], "a partner's unrelated parents remain private");
  assert.deepEqual(visiblePartner.spouses, ["child"], "a partner's other spouse remains private");
  assert.ok(!unchangedPeople.some((person) =>
    ["partner-parent", "partner-other-spouse"].includes(person.id)));
  assert.deepEqual(unchangedPeople.find((p) => p.id === "descendant")?.parents,
    ["child", "co-parent"]);
  assert.deepEqual(unchangedPeople.find((p) => p.id === "co-parent")?.parents,
    []);
  assert.deepEqual(unchangedPeople.find((p) => p.id === "co-parent")?.spouses, []);
  assert.ok(!unchangedPeople.some((p) => ["co-grandparent", "co-sibling", "co-other"].includes(p.id)));


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

  const removedCoParent = await race("/api/export.json", async () => {
    await second.query("DELETE FROM relations WHERE archive_id='tree-a' AND id='descendant-coparent'");
    await second.query("UPDATE archives SET revision=revision+1 WHERE id='tree-a'");
  });
  assert.equal(removedCoParent.status, 409, "a removed parent path withholds its prepared co-parent");
  const afterCoParentRemoval = await get("/api/export.json");
  assert.equal(afterCoParentRemoval.status, 200);
  assert.ok(!(await afterCoParentRemoval.json()).people.some((p: { id: string }) =>
    ["co-parent", "co-grandparent", "co-sibling", "co-other"].includes(p.id)));
  await second.query(`INSERT INTO relations(archive_id,id,source,target,type,ordinal)
    VALUES('tree-a','descendant-coparent','co-parent','descendant','parent',14)`);
  await second.query("UPDATE archives SET revision=revision+1 WHERE id='tree-a'");

  const removedPartner = await race("/api/export.json", async () => {
    await second.query("DELETE FROM relations WHERE archive_id='tree-a' AND id='blood-partner'");
    await second.query("UPDATE archives SET revision=revision+1 WHERE id='tree-a'");
  });
  assert.equal(removedPartner.status, 409,
    "removing the marriage before delivery withholds the prepared spouse data");
  assert.doesNotMatch(await removedPartner.text(), /partner/);
  const afterPartnerRemoval = await get("/api/export.json");
  assert.equal(afterPartnerRemoval.status, 200);
  assert.ok(!(await afterPartnerRemoval.json()).people.some((person: { id: string }) =>
    person.id === "partner"), "a fresh read no longer opens the former access path");
  await second.query(`INSERT INTO relations(archive_id,id,source,target,type,ordinal)
    VALUES('tree-a','blood-partner','child','partner','spouse',10)`);
  await second.query("UPDATE archives SET revision=revision+1 WHERE id='tree-a'");

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

  // A public tree does not require a session. Deleting a person after the
  // prepared snapshot but before HTTP delivery must withhold that snapshot.
  await second.query(`UPDATE archive_access_settings SET public_tree=true
    WHERE archive_id='tree-a'`);
  const publicFamily = await get("/api/family", "");
  assert.equal(publicFamily.status, 200);
  assert.equal((await publicFamily.json()).family.people.some(
    (person: { id: string }) => person.id === "father"), true);
  let overviewReached!: () => void;
  let releaseOverview!: () => void;
  const overviewReady = new Promise<void>((resolve) => { overviewReached = resolve; });
  const overviewGate = new Promise<void>((resolve) => { releaseOverview = resolve; });
  pauseRead = { reached: overviewReached, wait: overviewGate };
  const pendingOverview = get("/api/family?projection=overview", "");
  try {
    await Promise.race([overviewReady,
      new Promise<never>((_, reject) => setTimeout(() =>
        reject(new Error("public overview read was not reached")), 10_000))]);
    await second.query(`UPDATE people SET data=jsonb_set(data,'{name}',
      '"Changed Public Name"'::jsonb) WHERE archive_id='tree-a' AND id='father'`);
    await second.query("UPDATE archives SET revision=revision+1 WHERE id='tree-a'");
  } finally {
    releaseOverview();
  }
  const staleOverview = await pendingOverview;
  assert.equal(staleOverview.status, 409,
    "a prepared overview must not reveal a card changed before delivery");
  assert.doesNotMatch(await staleOverview.text(), /father|Changed Public Name/);
  const freshOverview = await get("/api/family?projection=overview", "");
  assert.equal(freshOverview.status, 200);
  const pageToken = (await freshOverview.json()).pageToken as string;
  let pageReached!: () => void;
  let releasePage!: () => void;
  const pageReady = new Promise<void>((resolve) => { pageReached = resolve; });
  const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
  pauseRead = { reached: pageReached, wait: pageGate };
  const pagePath = `/api/family?projection=page&collection=people&offset=0&token=${encodeURIComponent(pageToken)}`;
  const pendingPage = get(pagePath, "");
  try {
    await Promise.race([pageReady,
      new Promise<never>((_, reject) => setTimeout(() =>
        reject(new Error("public page read was not reached")), 10_000))]);
    await second.query(`UPDATE people SET data=jsonb_set(data,'{name}',
      '"Changed Again"'::jsonb) WHERE archive_id='tree-a' AND id='father'`);
    await second.query("UPDATE archives SET revision=revision+1 WHERE id='tree-a'");
  } finally {
    releasePage();
  }
  const stalePage = await pendingPage;
  assert.equal(stalePage.status, 409,
    "a prepared public page must not reveal a changed card");
  assert.doesNotMatch(await stalePage.text(), /father|Changed Again/);
  let publicReadReached!: () => void;
  let releasePublicRead!: () => void;
  const publicReady = new Promise<void>((resolve) => { publicReadReached = resolve; });
  const publicGate = new Promise<void>((resolve) => { releasePublicRead = resolve; });
  pauseRead = { reached: publicReadReached, wait: publicGate };
  const pendingPublic = get("/api/family", "");
  try {
    await Promise.race([publicReady,
      new Promise<never>((_, reject) => setTimeout(() =>
        reject(new Error("public family read was not reached")), 10_000))]);
    await second.query(`DELETE FROM relations WHERE archive_id='tree-a'
      AND (source='father' OR target='father')`);
    await second.query(`DELETE FROM people WHERE archive_id='tree-a' AND id='father'`);
    await second.query("UPDATE archives SET revision=revision+1 WHERE id='tree-a'");
  } finally {
    releasePublicRead();
  }
  const stalePublic = await pendingPublic;
  assert.equal(stalePublic.status, 409,
    "a prepared public tree must not reveal a person deleted before delivery");
  assert.doesNotMatch(await stalePublic.text(), /father|child/);
  const freshPublic = await get("/api/family", "");
  assert.equal(freshPublic.status, 200);
  assert.equal((await freshPublic.json()).family.people.some(
    (person: { id: string }) => person.id === "father"), false);

  const publicSearch = await get("/api/people/search?q=child", "");
  const publicSearchBody = await publicSearch.text();
  assert.equal(publicSearch.status, 200, publicSearchBody);
  assert.equal(JSON.parse(publicSearchBody).people.some(
    (person: { id: string }) => person.id === "child"), true);
  let searchReached!: () => void;
  let releaseSearch!: () => void;
  const searchReady = new Promise<void>((resolve) => { searchReached = resolve; });
  const searchGate = new Promise<void>((resolve) => { releaseSearch = resolve; });
  pauseDelivery = { reached: searchReached, wait: searchGate };
  const pendingSearch = get("/api/people/search?q=child", "");
  try {
    await Promise.race([searchReady,
      new Promise<never>((_, reject) => setTimeout(() =>
        reject(new Error("public search did not reach delivery")), 10_000))]);
    await second.query(`UPDATE people SET data=jsonb_set(data,'{name}',
      '"Changed Child"'::jsonb) WHERE archive_id='tree-a' AND id='child'`);
    await second.query("UPDATE archives SET revision=revision+1 WHERE id='tree-a'");
  } finally {
    releaseSearch();
  }
  const staleSearch = await pendingSearch;
  assert.equal(staleSearch.status, 409,
    "public search must not return a prepared card after its revision changes");
  assert.doesNotMatch(await staleSearch.text(), /child|Changed Child/);
});
