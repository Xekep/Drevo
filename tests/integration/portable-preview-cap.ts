import assert from "node:assert/strict";
import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import pg from "pg";
import { openArchive } from "../../src/server/database.ts";
import { portableImportHttp } from "../../src/server/portable-import-http.ts";
import { writePortablePackage } from "../../src/server/portable-package.ts";
import type { createAuth } from "../../src/server/auth.ts";

/** Three archive-local owners reach admission together; only two may be staged platform-wide. */
export async function verifyPortablePreviewGlobalCap(client: pg.Client, directory: string) {
  const ids = ["portable-cap-one", "portable-cap-two", "portable-cap-three"];
  const family = { title: "Empty", description: "", demo: false, people: [], photos: [] };
  const fixture = join(directory, "portable-cap-fixture");
  const packagePath = join(fixture, "archive.drevo");
  mkdirSync(fixture, { recursive: true });
  await writePortablePackage(createWriteStream(packagePath), fixture,
    { family, documents: [], comments: [] }, async () => {});
  const bytes = readFileSync(packagePath);
  const previousArchive = String((await client.query(
    "SELECT current_setting('drevo.archive_id',true) AS id",
  )).rows[0].id);
  let arrived = 0;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => { release = resolve; });
  const timeout = setTimeout(release, 10_000);
  const routes: Array<{ archive: Awaited<ReturnType<typeof openArchive>>;
    route: ReturnType<typeof portableImportHttp>;
    server: ReturnType<typeof createServer>; base: string }> = [];
  try {
    for (const id of ids) {
      await client.query("SELECT set_config('drevo.archive_id',$1,false)", [id]);
      await client.query(`INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version)
        VALUES($1,'Empty','',false,0,18)`, [id]);
      const path = join(directory, "archives", id, "source.sqlite");
      const archive = await openArchive(path, family, id);
      const actor = { id: `${id}-owner`, role: "admin", approved: true };
      const auth = { local: true, currentUser: async () => actor } as unknown as
        Awaited<ReturnType<typeof createAuth>>;
      let reads = 0;
      const gated = { ...archive, read: async () => {
        const snapshot = await archive.read();
        if (++reads === 2) {
          if (++arrived === ids.length) release();
          await allArrived;
        }
        return snapshot;
      } };
      const route = portableImportHttp(gated, auth, path);
      const server = createServer((req, res) => {
        void route.handle(req, res, new URL(req.url!, `http://${req.headers.host}`));
      });
      routes.push({ archive, route, server, base: "" });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      routes.at(-1)!.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    }
    const responses = await Promise.all(routes.map(({ base }) => fetch(`${base}/api/drevo/preview`, {
      method: "POST", headers: { Origin: base, "X-Drevo-Import": "1" }, body: bytes,
    })));
    assert.equal(arrived, ids.length, "all archive owners reached the admission barrier");
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 409],
      "three archive-local previews must share a two-slot platform cap");
    assert.equal((await client.query(
      "SELECT count(*)::int AS n FROM platform_portable_preview_slots",
    )).rows[0].n, 2);
    const released = responses.findIndex((response) => response.status === 200);
    const token = (await responses[released].json() as { token: string }).token;
    const stageExpiry = (await routes[released].archive.db.prepare("",
      "SELECT expires_at FROM workflow_stages WHERE token=?").get(token))?.expires_at;
    assert.equal(Number((await client.query(
      "SELECT expires_at FROM platform_portable_preview_slots WHERE token=$1", [token],
    )).rows[0]?.expires_at), stageExpiry,
    "the ready stage and its platform slot must expire together");
    await routes[released].archive.db.prepare("", "DELETE FROM workflow_stages WHERE token=?")
      .run(token);
    assert.equal((await client.query(
      "SELECT count(*)::int AS n FROM platform_portable_preview_slots",
    )).rows[0].n, 1, "removing a stage releases its platform slot");
    const denied = responses.findIndex((response) => response.status === 409);
    const retryBase = routes[denied].base;
    const retry = await fetch(`${retryBase}/api/drevo/preview`, {
      method: "POST", headers: { Origin: retryBase, "X-Drevo-Import": "1" }, body: bytes,
    });
    assert.equal(retry.status, 200, "a released slot can be claimed by another archive");
    assert.equal((await client.query(
      "SELECT count(*)::int AS n FROM platform_portable_preview_slots",
    )).rows[0].n, 2);
  } finally {
    clearTimeout(timeout);
    release();
    for (const { archive, route, server } of routes) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await route.close();
      await archive.close();
    }
    for (const id of ids) {
      await client.query("SELECT set_config('drevo.archive_id',$1,false)", [id]);
      await client.query("DELETE FROM archives WHERE id=$1", [id]);
      rmSync(join(directory, "archives", id), { recursive: true, force: true });
    }
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [previousArchive]);
    rmSync(fixture, { recursive: true, force: true });
  }
  assert.equal((await client.query(
    "SELECT count(*)::int AS n FROM platform_portable_preview_slots",
  )).rows[0].n, 0, "archive removal releases all remaining preview slots");
}
