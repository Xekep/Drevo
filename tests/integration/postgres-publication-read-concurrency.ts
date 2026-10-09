import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import pg from "pg";
import sharp from "sharp";
import { createAuth } from "../../src/server/auth.ts";
import type { openArchive } from "../../src/server/database.ts";
import { imagePreviews } from "../../src/server/image-previews.ts";
import { mediaHttp } from "../../src/server/media-http.ts";
import { mediaStore } from "../../src/server/media.ts";
import { publishedPeopleHttp } from "../../src/server/published-people-http.ts";
import { publishedPeopleStore } from "../../src/server/published-people.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { settingsStore } from "../../src/server/settings.ts";
import { userStore } from "../../src/server/users.ts";

/** Real row locks and HTTP delivery, using only the disposable runtime fixture. */
export async function verifyPublicationReadConcurrency(
  archive: Awaited<ReturnType<typeof openArchive>>,
  uploads: string,
) {
  const origin = "https://publication-read.invalid";
  const db = archive.db;
  const previous = await archive.read();
  const person = previous.family.people.find((entry) => entry.id === "person-a")!;
  assert.ok(person);
  const filename = "publication-read-concurrency.png";
  const url = `/media/${filename}`;
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3,
    background: "#85a378" } }).png().toBuffer();
  await writeFile(join(uploads, filename), bytes);
  await archive.write({ ...previous.family,
    people: previous.family.people.map((entry) => entry.id === person.id
      ? { ...entry, photo: url } : entry) }, previous.revision);
  const writer = new pg.Client();
  await writer.connect();
  await writer.query("SELECT set_config('drevo.archive_id',$1,false)", [db.archiveId]);
  const auth = await createAuth(await userStore(db), db, origin);
  const publication = publishedPeopleHttp({ archive, auth,
    store: publishedPeopleStore(db), publicOrigin: origin });
  const media = mediaHttp({ archive, auth, media: mediaStore(uploads),
    previewImage: imagePreviews(join(uploads, "publication-read-previews")),
    visibility: await settingsStore(db) });
  let reached!: () => void, release!: () => void;
  let gate = Promise.resolve();
  const server = createServer((req, res) => {
    if (req.headers["x-test-hold"] === "1") {
      const end = res.end.bind(res);
      res.end = ((...args: Parameters<typeof res.end>) => {
        reached();
        void gate.then(() => { end(...args); });
        return res;
      }) as typeof res.end;
    }
    const parsed = new URL(req.url || "/", origin);
    void (parsed.pathname.startsWith("/media/") ? media : publication)(req, res, parsed)
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cases = [
    { path: `/api/admin/published-people/batch?id=${person.id}`, method: "GET" },
    { path: "/api/admin/published-people/batch/preview", method: "POST",
      body: JSON.stringify({ action: "unpublish", personIds: [person.id] }) },
    { path: `/api/admin/published-people/${person.id}`, method: "GET" },
  ];
  try {
    for (const entry of cases) {
      const token = newSessionToken(), hash = sessionTokenHash(token);
      await writer.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
        [hash, Date.now() + 60_000]);
      const headers = { Cookie: `drevo_session=${token}`, Origin: origin,
        "Content-Type": "application/json" };
      const ready = new Promise<void>((resolve) => { reached = resolve; });
      gate = new Promise<void>((resolve) => { release = resolve; });
      const pending = fetch(base + entry.path, { method: entry.method, body: entry.body,
        headers: { ...headers, "X-Test-Hold": "1" }, signal: AbortSignal.timeout(10_000) });
      void pending.catch(() => {});
      let revocation: Promise<pg.QueryResult> | undefined;
      try {
        await Promise.race([ready, pending.then(() => {
          throw new Error("Publication read missed the held delivery barrier");
        })]);
        // The first publication response still owns its final permission locks.
        // Other readers must neither return 503 nor wait for that response.
        const concurrent = await Promise.all([
          fetch(base + url, { headers, signal: AbortSignal.timeout(2_000) }),
          fetch(base + url + "?variant=thumb", { headers, signal: AbortSignal.timeout(2_000) }),
        ]);
        assert.deepEqual(concurrent.map((response) => response.status), [200, 200], entry.path);
        assert.deepEqual(Buffer.from(await concurrent[0].arrayBuffer()), bytes);
        assert.match(concurrent[1].headers.get("content-type") || "", /image\/webp/);
        await concurrent[1].arrayBuffer();
        const otherRead = await fetch(base + `/api/admin/published-people/batch?id=${person.id}`,
          { headers, signal: AbortSignal.timeout(2_000) });
        assert.equal(otherRead.status, 200);
        await otherRead.json();
        // Shared reads must still exclude archive edits and session revocation.
        await writer.query("BEGIN");
        try {
          await assert.rejects(writer.query("SELECT id FROM archives WHERE id=$1 FOR UPDATE NOWAIT",
            [db.archiveId]), (error: unknown) => (error as { code?: string }).code === "55P03");
        } finally { await writer.query("ROLLBACK"); }
        revocation = writer.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
        const order = await Promise.race([revocation.then(() => "revoked"),
          new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100))]);
        assert.equal(order, "waiting", "revocation must wait for protected JSON delivery");
        release();
        assert.equal((await pending).status, 200);
        assert.equal((await revocation).rowCount, 1);
        const denied = await fetch(base + entry.path, { method: entry.method,
          body: entry.body, headers, signal: AbortSignal.timeout(2_000) });
        assert.equal(denied.status, 401);
        assert.doesNotMatch(await denied.text(), /"fields"|"person"|"people"/);
      } finally {
        release();
        await pending.catch(() => {});
        await revocation?.catch(() => {});
        await writer.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
      }
    }
    console.log("runtime_publication_read_concurrency_and_revocation_ok");
  } finally {
    release?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await writer.end();
    await archive.write(previous.family, (await archive.meta()).revision);
    await unlink(join(uploads, filename));
  }
}
