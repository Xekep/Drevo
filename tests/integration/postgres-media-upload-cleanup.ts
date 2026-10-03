import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import sharp from "sharp";
import { openArchive } from "../../src/server/database.ts";
import { startServer } from "../../src/server/index.ts";
import { userStore } from "../../src/server/users.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { importSqliteSnapshot } from "../../ops/postgres/import-sqlite.ts";
import type { Family } from "../../src/domain/types.ts";

if (!/^drevo_migration_runtime_media_cleanup_[a-z0-9_]+$/.test(process.env.PGDATABASE || ""))
  throw new Error("Use a new disposable drevo_migration_runtime_media_cleanup_* database");

test("a response failure after photo commit retains the committed original", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-pg-media-cleanup-"));
  const source = join(directory, "source.sqlite");
  const uploads = join(directory, "uploads");
  mkdirSync(uploads);
  const priorBackend = process.env.DATABASE_BACKEND;
  const priorArchiveId = process.env.ARCHIVE_ID;
  const priorOrigin = process.env.PUBLIC_ORIGIN;
  const client = new pg.Client();
  await client.connect();
  const resources: { app?: Awaited<ReturnType<typeof startServer>> } = {};
  t.after(async () => {
    await resources.app?.close();
    await client.end();
    rmSync(directory, { recursive: true, force: true });
    if (priorBackend === undefined) delete process.env.DATABASE_BACKEND;
    else process.env.DATABASE_BACKEND = priorBackend;
    if (priorArchiveId === undefined) delete process.env.ARCHIVE_ID;
    else process.env.ARCHIVE_ID = priorArchiveId;
    if (priorOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = priorOrigin;
  });
  assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n, 0);
  const family: Family = {
    title: "Synthetic upload", description: "", demo: false, photos: [], links: [],
    people: [{
      id: "person", name: "Person", surname: "Test", patronymic: "", sex: "m",
      birth: "2000", birthPlace: "", parents: [], spouses: [], sources: [],
      generation: 1, column: 0, createdBy: "owner",
    }],
  };
  delete process.env.DATABASE_BACKEND;
  const seed = await openArchive(source, family);
  await (await userStore(seed.db, { initialAdminId: "owner" })).register("owner", "Owner");
  await seed.close();
  await importSqliteSnapshot(source, uploads, "media-cleanup-test", client, "owner");
  process.env.DATABASE_BACKEND = "postgres";
  process.env.ARCHIVE_ID = "media-cleanup-test";
  process.env.PUBLIC_ORIGIN = "https://archive.test";
  const app = await startServer(0, source, true);
  resources.app = app;
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const token = newSessionToken();
  await app.archive.db.prepare("", "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'owner',?)")
    .run(sessionTokenHash(token), Date.now() + 60_000);
  const revision = (await app.archive.meta()).revision;
  let injected = false;
  app.server.prependListener("request", (req, res) => {
    if (req.url !== "/api/photos") return;
    const original = res.writeHead.bind(res) as (...args: unknown[]) => typeof res;
    res.writeHead = ((status: number, ...args: unknown[]) => {
      if (status === 201 && !injected) {
        injected = true;
        throw new Error("Synthetic response failure after commit");
      }
      return original(status, ...args);
    }) as typeof res.writeHead;
  });
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const response = await fetch(base + "/api/photos", {
    method: "POST",
    headers: {
      Cookie: `drevo_session=${token}`,
      Origin: process.env.PUBLIC_ORIGIN,
      "If-Match": String(revision),
      "X-Drevo-Upload": "1",
      "X-Photo-Metadata": encodeURIComponent(JSON.stringify({ title: "Photo" })),
    },
    body: png,
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Фото сохранено. Обновите архив.",
    saved: true,
  });
  assert.equal(injected, true);
  const current = await app.archive.read();
  assert.equal(current.family.photos?.length, 1, "the graph commit preceded response delivery");
  const url = current.family.photos![0].url;
  assert.equal((await app.archive.db.prepare("", "SELECT 1 FROM media_originals WHERE url=?").get(url)) !== undefined, true,
    "committed photo retains metadata used by the media quota");
  assert.equal(existsSync(join(uploads, url.slice("/media/".length))), true,
    "committed photo retains its original file");

  const invalid = await fetch(base + "/api/photos", {
    method: "POST",
    headers: {
      Cookie: `drevo_session=${token}`,
      Origin: process.env.PUBLIC_ORIGIN,
      "If-Match": String(current.revision),
      "X-Drevo-Upload": "1",
      "X-Photo-Metadata": "%",
    },
    body: png,
  });
  assert.equal(invalid.status, 400, "invalid metadata fails before graph commit");
  assert.equal(Number((await app.archive.db.prepare("", "SELECT count(*) AS n FROM media_originals").get())?.n), 1);
  assert.equal(readdirSync(uploads).length, 1, "pre-commit failure still deletes its unreferenced file");
});
