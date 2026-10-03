import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { createAuth } from "../../src/server/auth.ts";
import type { openArchive } from "../../src/server/database.ts";
import { imagePreviews } from "../../src/server/image-previews.ts";
import { mediaHttp } from "../../src/server/media-http.ts";
import { mediaStore } from "../../src/server/media.ts";
import { settingsStore } from "../../src/server/settings.ts";
import { userStore } from "../../src/server/users.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";

async function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A completed revoke after an HTTP user snapshot must win before an original's first byte. */
export async function verifyPostgresMediaReadDelivery(
  archive: Awaited<ReturnType<typeof openArchive>>,
  client: Client,
) {
  const archiveId = archive.db.archiveId;
  assert.ok(archiveId, "media delivery regression requires a selected archive");
  const directory = await mkdtemp(join(tmpdir(), "drevo-media-delivery-"));
  const url = "/media/private-original.jpg";
  const bytes = Buffer.alloc(1024 * 1024, 0x5a);
  const photoData = JSON.stringify({
    id: "media-delivery-photo", title: "Private", url, tags: [],
  });
  const token = newSessionToken();
  const tokenHash = sessionTokenHash(token);
  const baseAuth = await createAuth(await userStore(archive.db), archive.db,
    "https://media-delivery.invalid");
  let userCalls = 0;
  let armed = false;
  let pauseDelivery = false;
  let pauseLockedDelivery = false;
  let deliveryReached!: () => void;
  let deliveryResume!: () => void;
  let deliveryGate = Promise.resolve();
  let lockedReached!: () => void;
  let lockedResume!: () => void;
  let lockedGate = Promise.resolve();
  let reached!: () => void;
  let resume!: () => void;
  let barrier = Promise.resolve();
  const auth = {
    ...baseAuth,
    currentUser: async (req: IncomingMessage) => {
      const user = await baseAuth.currentUser(req);
      if (armed && ++userCalls === 2) {
        reached();
        await barrier;
      }
      return user;
    },
  };
  const media = mediaStore(directory);
  const visibility = await settingsStore(archive.db);
  const initialVisibility = await visibility.read();
  const route = mediaHttp({
    auth, archive, media,
    previewImage: imagePreviews(join(directory, "previews")),
    visibility,
    beforeDelivery: async () => {
      if (pauseDelivery) {
        deliveryReached();
        await deliveryGate;
      }
    },
    beforeLockedDelivery: async () => {
      if (pauseLockedDelivery) {
        lockedReached();
        await lockedGate;
      }
    },
  });
  let streamStalled!: () => void;
  let streamCompleted!: () => void;
  const atStreamStall = new Promise<void>((resolve) => { streamStalled = resolve; });
  const afterStream = new Promise<void>((resolve) => { streamCompleted = resolve; });
  const server = createServer((req, res) => {
    const slow = req.headers["x-slow-original"] === "1";
    if (slow) {
      const write = res.write.bind(res);
      let chunks = 0;
      res.write = ((...args: Parameters<typeof res.write>) => {
        if (++chunks === 1) return write(...args);
        streamStalled();
        return false;
      }) as typeof res.write;
    }
    void route(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error))
      .finally(() => { if (slow) streamCompleted(); });
  });
  await writeFile(join(directory, "private-original.jpg"), bytes);
  assert.equal(media.openOriginal(url)?.path, join(directory, "private-original.jpg"));
  assert.deepEqual(await readFile(media.openOriginal(url)!.path), bytes);
  await archive.db.prepare("", "INSERT INTO photos(id,data) VALUES(?,?::jsonb)")
    .run("media-delivery-photo", photoData);
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'reader',$2)",
    [tokenHash, Date.now() + 600_000],
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const control = await fetch(base + url, { headers: { Cookie: `drevo_session=${token}` } });
    assert.equal(control.status, 200);
    assert.deepEqual(Buffer.from(await control.arrayBuffer()), bytes);
    const outcomes: Array<{ kind: string; status: number; body: Buffer }> = [];
    for (const kind of ["session", "membership"] as const) {
      userCalls = 0;
      armed = true;
      const atUser = new Promise<void>((resolve) => { reached = resolve; });
      barrier = new Promise<void>((resolve) => { resume = resolve; });
      const pending = fetch(base + url, { headers: { Cookie: `drevo_session=${token}` } });
      try {
        await within(Promise.race([
          atUser,
          pending.then(() => { throw new Error("Media response passed the user barrier"); }),
        ]), 10_000, "Media user barrier missing");
        if (kind === "session")
          await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [tokenHash]);
        else
          await client.query(`UPDATE archive_memberships SET approved=false
            WHERE archive_id=$1 AND user_id='reader'`, [archiveId]);
        resume();
        const response = await pending;
        outcomes.push({ kind, status: response.status,
          body: Buffer.from(await response.arrayBuffer()) });
      } finally {
        armed = false;
        resume();
        if (kind === "session")
          await client.query(
            "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'reader',$2) ON CONFLICT DO NOTHING",
            [tokenHash, Date.now() + 600_000],
          );
        else
          await client.query(`UPDATE archive_memberships SET approved=true
            WHERE archive_id=$1 AND user_id='reader'`, [archiveId]);
      }
    }
    assert.deepEqual(outcomes.map(({ status }) => status), [401, 401],
      "completed session and membership revocations must stop originals before the first byte");
    for (const { kind, body } of outcomes)
      assert.notDeepEqual(body, bytes, `${kind} revocation must withhold the original bytes`);
    await visibility.write({ ...initialVisibility, publicTree: false, publicAlbums: true });
    const publicControl = await fetch(base + url);
    assert.equal(publicControl.status, 200);
    assert.deepEqual(Buffer.from(await publicControl.arrayBuffer()), bytes);
    for (const kind of ["visibility", "reference"] as const) {
      const atDelivery = new Promise<void>((resolve) => { deliveryReached = resolve; });
      deliveryGate = new Promise<void>((resolve) => { deliveryResume = resolve; });
      pauseDelivery = true;
      const pending = fetch(base + url);
      try {
        await within(Promise.race([atDelivery,
          pending.then(() => { throw new Error("Public media passed the delivery barrier"); })]),
        10_000, "Public media delivery barrier missing");
        if (kind === "visibility")
          await visibility.write({ ...initialVisibility, publicTree: false, publicAlbums: false });
        else
          await archive.db.transaction(async () => {
            await archive.db.prepare("", "DELETE FROM photos WHERE id=?")
              .run("media-delivery-photo");
            await archive.db.prepare("", "UPDATE archives SET revision=revision+1 WHERE id=?")
              .run(archiveId);
          });
        deliveryResume();
        const response = await pending;
        assert.equal(response.status, kind === "reference" ? 409 : 401,
          `completed public ${kind} change must withhold the original`);
        assert.notDeepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      } finally {
        pauseDelivery = false;
        deliveryResume();
        if (kind === "visibility")
          await visibility.write({ ...initialVisibility, publicTree: false, publicAlbums: true });
        else
          await archive.db.transaction(async () => {
            await archive.db.prepare("", "INSERT INTO photos(id,data) VALUES(?,?::jsonb)")
              .run("media-delivery-photo", photoData);
            await archive.db.prepare("", "UPDATE archives SET revision=revision+1 WHERE id=?")
              .run(archiveId);
          });
      }
    }
    const atLocked = new Promise<void>((resolve) => { lockedReached = resolve; });
    lockedGate = new Promise<void>((resolve) => { lockedResume = resolve; });
    pauseLockedDelivery = true;
    const lockedPending = fetch(base + url);
    let toggle: Promise<unknown> | undefined;
    try {
      await within(atLocked, 10_000, "Public media did not reach locked handoff");
      let toggled = false;
      toggle = visibility.write({ ...initialVisibility, publicTree: false, publicAlbums: false })
        .then(() => { toggled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(toggled, false,
        "public visibility toggle must wait until the first original chunk");
      lockedResume();
      const response = await lockedPending;
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      await within(toggle, 3_000, "Public visibility toggle did not finish after handoff");
      assert.equal((await fetch(base + url)).status, 401);
    } finally {
      pauseLockedDelivery = false;
      lockedResume();
      await toggle?.catch(() => {});
      await visibility.write({ ...initialVisibility, publicTree: false, publicAlbums: false });
    }
    const pendingUrl = "/media/pending-original.jpg";
    await writeFile(join(directory, "pending-original.jpg"), bytes);
    await archive.db.prepare("", `INSERT INTO media_upload_grants(url,user_id,expires_ms)
      VALUES(?,'reader',?)`).run(pendingUrl, Date.now() + 600_000);
    const pendingControl = await fetch(base + pendingUrl,
      { headers: { Cookie: `drevo_session=${token}` } });
    assert.equal(pendingControl.status, 200);
    assert.deepEqual(Buffer.from(await pendingControl.arrayBuffer()), bytes);
    const atGrantDelivery = new Promise<void>((resolve) => { deliveryReached = resolve; });
    deliveryGate = new Promise<void>((resolve) => { deliveryResume = resolve; });
    pauseDelivery = true;
    const granted = fetch(base + pendingUrl,
      { headers: { Cookie: `drevo_session=${token}` } });
    try {
      await within(atGrantDelivery, 10_000, "Pending original did not reach delivery barrier");
      await client.query("DELETE FROM media_upload_grants WHERE archive_id=$1 AND url=$2",
        [archiveId, pendingUrl]);
      deliveryResume();
      const response = await granted;
      assert.equal(response.status, 401,
        "a removed pending-upload grant cannot release an unattached original");
      assert.notDeepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    } finally {
      pauseDelivery = false;
      deliveryResume();
      await client.query("DELETE FROM media_upload_grants WHERE archive_id=$1 AND url=$2",
        [archiveId, pendingUrl]);
    }
    const abort = new AbortController();
    try {
      const response = await fetch(base + url, {
        headers: { Cookie: `drevo_session=${token}`, "x-slow-original": "1" },
        signal: abort.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body?.getReader();
      assert.ok(reader);
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.ok(first.value?.byteLength);
      await within(atStreamStall, 10_000,
        "Original stream did not reach its slow continuation");
      const released = Promise.all([
        archive.db.transaction(async () => true),
        client.query(`UPDATE archive_memberships SET approved=false
          WHERE archive_id=$1 AND user_id='reader'`, [archiveId]),
      ]);
      const [, revoke] = await within(released, 3_000,
        "Slow original retained archive or member lock");
      assert.equal(revoke.rowCount, 1);
      abort.abort();
      await within(afterStream, 3_000, "Aborted original did not close its stream");
    } finally {
      abort.abort();
      await client.query(`UPDATE archive_memberships SET approved=true
        WHERE archive_id=$1 AND user_id='reader'`, [archiveId]);
    }
  } finally {
    resume?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [tokenHash]);
    await archive.db.prepare("", "DELETE FROM photos WHERE id=?").run("media-delivery-photo");
    await visibility.write(initialVisibility);
    await rm(directory, { recursive: true, force: true });
  }
  console.log("postgres_media_read_delivery_verified");
}
