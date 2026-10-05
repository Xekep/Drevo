import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import pg from "pg";
import sharp from "sharp";
import { openArchive } from "../../src/server/database.ts";
import { startServer } from "../../src/server/index.ts";
import { userStore } from "../../src/server/users.ts";
import { createAuth } from "../../src/server/auth.ts";
import { mediaStore } from "../../src/server/media.ts";
import { mediaUploadHttp } from "../../src/server/media-upload-http.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { importSqliteSnapshot } from "../../ops/postgres/import-sqlite.ts";
import type { Family } from "../../src/domain/types.ts";

if (!/^drevo_migration_runtime_media_cleanup_[a-z0-9_]+$/.test(process.env.PGDATABASE || ""))
  throw new Error("Use a new disposable drevo_migration_runtime_media_cleanup_* database");

test("photo uploads keep originals after commit and reject revoked issuing sessions", async (t) => {
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
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='relations'
      AND column_name='confidence'`)).rows[0].n, 1,
  "a fresh SQLite import installs link confidence before the first runtime read");
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

  const blocker = new pg.Client();
  await blocker.connect();
  t.after(async () => blocker.end());
  await client.query("SELECT set_config('drevo.archive_id','media-cleanup-test',false)");
  await blocker.query("SELECT set_config('drevo.archive_id','media-cleanup-test',false)");
  const waitFor = async (predicate: () => Promise<boolean>, label: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const rows = async () => {
    const result = await client.query<{ photos: number; originals: number; grants: number }>(
      `SELECT (SELECT count(*)::int FROM photos) AS photos,
              (SELECT count(*)::int FROM media_originals) AS originals,
              (SELECT count(*)::int FROM media_upload_grants) AS grants`,
    );
    return result.rows[0];
  };
  const uploadHeaders = (token: string) => ({
    Cookie: `drevo_session=${token}`,
    Origin: process.env.PUBLIC_ORIGIN!,
    "X-Drevo-Upload": "1",
  });
  const preflightAuth = await createAuth(await userStore(app.archive.db), app.archive.db,
    process.env.PUBLIC_ORIGIN);
  await (await userStore(app.archive.db)).register("preflight-editor", "Editor");
  await client.query(`UPDATE archive_memberships SET role='relative',approved=true
    WHERE archive_id='media-cleanup-test' AND user_id='preflight-editor'`);
  for (const lostAccess of ["logout", "membership"] as const) {
    const accountId = lostAccess === "logout" ? "owner" : "preflight-editor";
    const preflightToken = newSessionToken();
    const preflightHash = sessionTokenHash(preflightToken);
    await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [preflightHash, accountId, Date.now() + 60_000]);
    let reached = false;
    let resume!: () => void;
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const gatedAuth = {
      ...preflightAuth,
      async canEdit(req: Parameters<typeof preflightAuth.canEdit>[0]) {
        const allowed = await preflightAuth.canEdit(req);
        if (allowed) {
          reached = true;
          await held;
        }
        return allowed;
      },
    };
    const gatedHandler = mediaUploadHttp({ archive: app.archive, auth: gatedAuth,
      media: mediaStore(uploads), publicOrigin: process.env.PUBLIC_ORIGIN,
      uploadsDirectory: uploads });
    const gatedServer = createServer((req, res) => {
      void gatedHandler(req, res, new URL(req.url || "/", "http://localhost"))
        .then((handled) => { if (!handled) res.writeHead(404).end(); })
        .catch((error) => { if (!res.headersSent) res.writeHead(500).end(String(error)); });
    });
    await new Promise<void>((resolve) => gatedServer.listen(0, "127.0.0.1", resolve));
    try {
      const before = await rows();
      const fileCount = readdirSync(uploads).length;
      const preflightRequest = fetch(
        `http://127.0.0.1:${(gatedServer.address() as { port: number }).port}/api/photos`, {
          method: "POST",
          headers: { ...uploadHeaders(preflightToken),
            "If-Match": String((await app.archive.meta()).revision) },
          body: png,
        },
      );
      await waitFor(async () => reached, `${lostAccess} after the first edit check`);
      if (lostAccess === "logout")
        await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [preflightHash]);
      else
        await client.query(`UPDATE archive_memberships SET approved=false
          WHERE archive_id='media-cleanup-test' AND user_id='preflight-editor'`);
      resume();
      const denied = await preflightRequest;
      assert.equal(denied.status, lostAccess === "logout" ? 401 : 403,
        `${lostAccess} between preflight lookups must not become an internal error`);
      assert.deepEqual(await denied.json(), { error: "You do not have editing access" });
      assert.deepEqual(await rows(), before, "preflight denial creates no photo or grant");
      assert.equal(readdirSync(uploads).length, fileCount,
        "preflight denial does not retain an original file");
    } finally {
      resume();
      await new Promise<void>((resolve) => gatedServer.close(() => resolve()));
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [preflightHash]);
      await client.query(`UPDATE archive_memberships SET approved=true
        WHERE archive_id='media-cleanup-test' AND user_id='preflight-editor'`);
    }
  }
  // The body is deliberately held open after quota reservation. This lets the
  // test take the archive lock before the handler's last user lookup, without
  // a production-only hook in the photo route.
  for (const { path, revoke } of [
    { path: "/api/photos", revoke: "session" },
    { path: "/api/portraits", revoke: "session" },
    { path: "/api/photos", revoke: "membership" },
  ] as const) {
    const raceToken = newSessionToken();
    const raceHash = sessionTokenHash(raceToken);
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
      [raceHash, Date.now() + 60_000],
    );
    const before = await rows();
    const fileCount = readdirSync(uploads).length;
    let finishBody!: () => void;
    let bodyFinished = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(png.subarray(0, 12));
        finishBody = () => {
          if (bodyFinished) return;
          bodyFinished = true;
          controller.enqueue(png.subarray(12));
          controller.close();
        };
      },
    });
    const request = fetch(base + path, {
      method: "POST",
      headers: { ...uploadHeaders(raceToken), "If-Match": String((await app.archive.meta()).revision) },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    let holding = false;
    try {
      await waitFor(async () => Number((await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM document_upload_requests WHERE user_id='owner' AND reserved_bytes>0",
      )).rows[0].n) > 0, `${path} reservation`);
      await blocker.query("BEGIN");
      holding = true;
      await blocker.query("SELECT id FROM archives WHERE id='media-cleanup-test' FOR UPDATE");
      const blockerPid = (await blocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      )).rows[0].pid;
      finishBody();
      await waitFor(async () => (await client.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND $1=ANY(pg_blocking_pids(pid))
            AND query LIKE 'SELECT id FROM archives WHERE id=%') AS blocked`,
        [blockerPid],
      )).rows[0].blocked, `${path} final archive transaction`);
      if (revoke === "session")
        assert.equal((await client.query(
          "DELETE FROM account_sessions WHERE token_hash=$1", [raceHash],
        )).rowCount, 1, "logout completes before the final upload transaction");
      else
        assert.equal((await client.query(
          "UPDATE archive_memberships SET approved=false WHERE archive_id='media-cleanup-test' AND user_id='owner'",
        )).rowCount, 1, "membership revoke completes before the final upload transaction");
      await blocker.query("COMMIT");
      holding = false;
      const denied = await request;
      assert.equal(denied.status, revoke === "session" ? 401 : 403,
        await denied.clone().text());
      if (revoke === "membership")
        await client.query("UPDATE archive_memberships SET approved=true WHERE archive_id='media-cleanup-test' AND user_id='owner'");
      assert.deepEqual(await rows(), before, `${path} rollback leaves no grant or photo`);
      assert.equal(readdirSync(uploads).length, fileCount,
        `${path} rollback removes the original file`);
    } finally {
      finishBody();
      if (holding) await blocker.query("ROLLBACK");
      await request.catch(() => {});
      if (revoke === "membership")
        await client.query("UPDATE archive_memberships SET approved=true WHERE archive_id='media-cleanup-test' AND user_id='owner'");
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [raceHash]);
    }
  }
  const activeToken = newSessionToken();
  const activeHash = sessionTokenHash(activeToken);
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
    [activeHash, Date.now() + 60_000],
  );
  const active = await fetch(base + "/api/photos", {
    method: "POST",
    headers: { ...uploadHeaders(activeToken),
      "If-Match": String((await app.archive.meta()).revision) },
    body: png,
  });
  assert.equal(active.status, 201, await active.clone().text());
  assert.equal((await active.json()).family.photos.length, 2,
    "an active issuing session still saves and receives the photo");
  await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [activeHash]);

  const handoffToken = newSessionToken();
  const handoffHash = sessionTokenHash(handoffToken);
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
    [handoffHash, Date.now() + 60_000],
  );
  let enterHandoff!: () => void;
  let releaseHandoff!: () => void;
  const atHandoff = new Promise<void>((resolve) => { enterHandoff = resolve; });
  const handoffGate = new Promise<void>((resolve) => { releaseHandoff = resolve; });
  const originalTransaction = app.archive.db.transaction;
  const handoffRevision = (await app.archive.meta()).revision;
  let armed = true;
  app.archive.db.transaction = async <T>(work: () => Promise<T>, readOnly?: boolean) => {
    const result = await originalTransaction(work, readOnly);
    if (armed && result && typeof result === "object" &&
        "family" in result && "revision" in result &&
        result.revision === handoffRevision + 1) {
      armed = false;
      enterHandoff();
      await handoffGate;
    }
    return result;
  };
  try {
    const committed = fetch(base + "/api/photos", {
      method: "POST",
      headers: { ...uploadHeaders(handoffToken),
        "If-Match": String(handoffRevision),
        "X-Photo-Metadata": encodeURIComponent(JSON.stringify({ title: "Private synthetic photo" })) },
      body: png,
    });
    await Promise.race([atHandoff, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Photo did not reach committed handoff")), 5_000))]);
    assert.equal((await app.archive.read()).family.photos?.length, 3,
      "photo and original have committed before response delivery");
    assert.equal((await client.query(
      "DELETE FROM account_sessions WHERE token_hash=$1", [handoffHash],
    )).rowCount, 1);
    releaseHandoff();
    const response = await committed;
    assert.equal(response.status, 201);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { committed: true, accessChanged: true });
    assert.doesNotMatch(body, /Private synthetic photo|\/media\//);
  } finally {
    releaseHandoff();
    app.archive.db.transaction = originalTransaction;
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [handoffHash]);
  }

  const concurrentToken = newSessionToken();
  const concurrentHash = sessionTokenHash(concurrentToken);
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
    [concurrentHash, Date.now() + 60_000],
  );
  let enteredConcurrent!: () => void;
  let releaseConcurrent!: () => void;
  const atConcurrent = new Promise<void>((resolve) => { enteredConcurrent = resolve; });
  const concurrentGate = new Promise<void>((resolve) => { releaseConcurrent = resolve; });
  const beforeConcurrent = await app.archive.read();
  const countBeforeConcurrent = beforeConcurrent.family.photos?.length || 0;
  let pauseConcurrent = true;
  app.archive.db.transaction = async <T>(work: () => Promise<T>, readOnly?: boolean) => {
    const result = await originalTransaction(work, readOnly);
    if (pauseConcurrent && result && typeof result === "object" &&
        "family" in result && "revision" in result &&
        result.revision === beforeConcurrent.revision + 1) {
      pauseConcurrent = false;
      enteredConcurrent();
      await concurrentGate;
    }
    return result;
  };
  try {
    const pending = fetch(base + "/api/photos", {
      method: "POST",
      headers: { ...uploadHeaders(concurrentToken),
        "If-Match": String(beforeConcurrent.revision) },
      body: png,
    });
    await Promise.race([atConcurrent, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Concurrent photo did not commit")), 5_000))]);
    const saved = await app.archive.read();
    assert.equal(saved.family.photos?.length, countBeforeConcurrent + 1);
    await app.archive.write({ ...saved.family, title: "Synthetic concurrent archive edit" },
      saved.revision);
    releaseConcurrent();
    const response = await pending;
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { committed: true, refreshRequired: true },
      "a second editor's revision change is not an access revocation");
    assert.equal((await app.archive.read()).family.photos?.length,
      countBeforeConcurrent + 1, "the first photo was committed only once");
    const stillAllowed = await fetch(base + "/api/family", {
      headers: { Cookie: `drevo_session=${concurrentToken}`, Origin: process.env.PUBLIC_ORIGIN! },
    });
    assert.equal(stillAllowed.status, 200, "the editor retains archive access");
  } finally {
    releaseConcurrent();
    app.archive.db.transaction = originalTransaction;
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [concurrentHash]);
  }

  // Hold an expired grant row after the first session lock but before the
  // final commit. The short-lived session must roll back every upload record.
  const expiredUrl = `/media/${randomUUID()}.png`;
  await client.query(
    "INSERT INTO media_upload_grants(url,user_id,expires_ms) VALUES($1,'owner',$2)",
    [expiredUrl, Date.now() - 1000],
  );
  const expiryToken = newSessionToken();
  const expiryHash = sessionTokenHash(expiryToken);
  const expiresAt = Date.now() + 2_500;
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
    [expiryHash, expiresAt],
  );
  const directAuth = await createAuth(await userStore(app.archive.db), app.archive.db,
    process.env.PUBLIC_ORIGIN);
  const directHandler = mediaUploadHttp({ archive: app.archive, auth: directAuth,
    media: mediaStore(uploads), publicOrigin: process.env.PUBLIC_ORIGIN,
    uploadsDirectory: uploads });
  const directServer = createServer((req, res) => {
    void directHandler(req, res, new URL(req.url || "/", "http://localhost"))
      .then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error) => { if (!res.headersSent) res.writeHead(500).end(String(error)); });
  });
  await new Promise<void>((resolve) => directServer.listen(0, "127.0.0.1", resolve));
  try {
    const directBase = `http://127.0.0.1:${(directServer.address() as { port: number }).port}`;
    const beforeExpiry = await rows();
    const fileCount = readdirSync(uploads).length;
    await blocker.query("BEGIN");
    let holding = true;
    try {
      await blocker.query("SELECT url FROM media_upload_grants WHERE url=$1 FOR UPDATE",
        [expiredUrl]);
      const blockerPid = (await blocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      )).rows[0].pid;
      const expiring = fetch(directBase + "/api/portraits", {
        method: "POST",
        headers: { ...uploadHeaders(expiryToken),
          "If-Match": String((await app.archive.meta()).revision) },
        body: png,
      });
      await waitFor(async () => (await client.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND $1=ANY(pg_blocking_pids(pid))
            AND query LIKE 'DELETE FROM media_upload_grants WHERE expires_ms%') AS blocked`,
        [blockerPid],
      )).rows[0].blocked, "portrait grant registration after session lock");
      await new Promise((resolve) => setTimeout(resolve,
        Math.max(0, expiresAt - Date.now() + 100)));
      assert.ok(Date.now() >= expiresAt);
      await blocker.query("COMMIT");
      holding = false;
      const denied = await expiring;
      assert.equal(denied.status, 401, await denied.clone().text());
      assert.deepEqual(await rows(), beforeExpiry,
        "expiry during registration rolls back the grant and original");
      assert.equal(readdirSync(uploads).length, fileCount);
    } finally {
      if (holding) await blocker.query("ROLLBACK");
    }
  } finally {
    await new Promise<void>((resolve) => directServer.close(() => resolve()));
    await client.query("DELETE FROM media_upload_grants WHERE url=$1", [expiredUrl]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [expiryHash]);
  }
  const orderedUrl = `/media/${randomUUID()}.png`;
  const orderedToken = newSessionToken();
  const orderedHash = sessionTokenHash(orderedToken);
  await client.query(
    "INSERT INTO media_upload_grants(url,user_id,expires_ms) VALUES($1,'owner',$2)",
    [orderedUrl, Date.now() - 1000],
  );
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
    [orderedHash, Date.now() + 60_000],
  );
  const revoker = new pg.Client();
  await revoker.connect();
  t.after(async () => revoker.end());
  await blocker.query("BEGIN");
  let holdingOrdered = true;
  try {
    await blocker.query("SELECT url FROM media_upload_grants WHERE url=$1 FOR UPDATE",
      [orderedUrl]);
    const blockerPid = (await blocker.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    )).rows[0].pid;
    const beforeOrdered = await rows();
    const orderedUpload = fetch(base + "/api/photos", {
      method: "POST",
      headers: { ...uploadHeaders(orderedToken),
        "If-Match": String((await app.archive.meta()).revision) },
      body: png,
    });
    await waitFor(async () => (await client.query<{ blocked: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND $1=ANY(pg_blocking_pids(pid))
          AND query LIKE 'DELETE FROM media_upload_grants WHERE expires_ms%') AS blocked`,
      [blockerPid],
    )).rows[0].blocked, "accepted photo upload after session lock");
    let revoked = false;
    const revoke = revoker.query(
      "DELETE FROM account_sessions WHERE token_hash=$1", [orderedHash],
    ).then((result) => { revoked = result.rowCount === 1; });
    await Promise.race([revoke, new Promise((resolve) => setTimeout(resolve, 200))]);
    assert.equal(revoked, false, "logout waits for the accepted photo transaction");
    await blocker.query("COMMIT");
    holdingOrdered = false;
    const response = await orderedUpload;
    assert.equal(response.status, 201, await response.clone().text());
    await response.text();
    await revoke;
    const afterOrdered = await rows();
    assert.equal(afterOrdered.photos, beforeOrdered.photos + 1);
    assert.equal(afterOrdered.originals, beforeOrdered.originals + 1);
    assert.equal(afterOrdered.grants, beforeOrdered.grants - 1,
      "attachment removes the temporary grant along with the expired fixture");
    const deniedNext = await fetch(base + "/api/photos", {
      method: "POST",
      headers: { ...uploadHeaders(orderedToken),
        "If-Match": String((await app.archive.meta()).revision) },
      body: png,
    });
    assert.equal(deniedNext.status, 401, "completed logout blocks the next upload");
  } finally {
    if (holdingOrdered) await blocker.query("ROLLBACK");
    await client.query("DELETE FROM media_upload_grants WHERE url=$1", [orderedUrl]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [orderedHash]);
  }
  await waitFor(async () => Number((await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM document_upload_requests WHERE user_id='owner' AND reserved_bytes>0",
  )).rows[0].n) === 0, "released upload reservations");
  console.log("runtime_photo_upload_session_revocation_ok");
});
