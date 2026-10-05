import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createAuth } from "../src/server/auth.ts";
import { openArchive } from "../src/server/database.ts";
import { mediaUploadHttp } from "../src/server/media-upload-http.ts";
import { mediaStore } from "../src/server/media.ts";
import { newSessionToken, sessionTokenHash } from "../src/server/session-token.ts";
import { userStore } from "../src/server/users.ts";

type Route = "photos" | "portraits";
type Scenario = "logout" | "expiry" | "reader" | "unapproved" | "public success" | "local success";

async function uploadScenario(route: Route, scenario: Scenario) {
  const directory = mkdtempSync(join(tmpdir(), `drevo-${route}-session-`));
  const uploads = join(directory, "uploads");
  mkdirSync(uploads);
  const archive = await openArchive(join(directory, "archive.sqlite"), {
    title: "Тест", description: "", demo: false, people: [],
  });
  const users = await userStore(archive.db);
  const owner = await users.register("owner", "Владелец");
  const local = scenario === "local success";
  const origin = local ? undefined : "https://archive.test";
  const auth = await createAuth(users, archive.db, origin);
  const initialRevision = (await archive.meta()).revision;
  const media = mediaStore(uploads);
  const handle = mediaUploadHttp({ archive, auth, media,
    publicOrigin: origin, uploadsDirectory: uploads });
  const token = newSessionToken();
  if (!local)
    await archive.db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
      .run(sessionTokenHash(token), owner.id, Date.now() + 60_000);
  const originalMeta = archive.meta;
  let metaReads = 0;
  archive.meta = async () => {
    const value = await originalMeta();
    if (++metaReads === 2) {
      // Complete the competing mutation after the upload's actor lookup but
      // before its original/grant or graph writer transaction starts.
      if (scenario === "logout")
        await archive.db.prepare("DELETE FROM auth_sessions WHERE token_hash=?")
          .run(sessionTokenHash(token));
      if (scenario === "expiry")
        await archive.db.prepare("UPDATE auth_sessions SET expires_at=? WHERE token_hash=?")
          .run(Date.now() - 1, sessionTokenHash(token));
      if (scenario === "reader")
        await archive.db.prepare("UPDATE users SET role='reader' WHERE id=?").run(owner.id);
      if (scenario === "unapproved")
        await archive.db.prepare("UPDATE users SET approved=0 WHERE id=?").run(owner.id);
    }
    return value;
  };
  const server = createServer((req, res) => {
    void handle(req, res, new URL(req.url!, "http://localhost")).catch(() => {
      res.writeHead(500);
      res.end("Unexpected handler failure");
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const image = await sharp({ create: { width: 2, height: 2, channels: 3,
      background: "green" } }).png().toBuffer();
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/${route}`, {
      method: "POST",
      headers: { ...(origin ? { Origin: origin, Cookie: `drevo_session=${token}` } : {}),
        "X-Drevo-Upload": "1", "If-Match": String(initialRevision) },
      body: image,
    });
    assert.ok(metaReads >= 2, "the upload passed the actor/revision boundary");
    const success = scenario.endsWith("success");
    assert.equal(response.status, success ? 201 : scenario === "reader" || scenario === "unapproved" ? 403 : 401,
      await response.clone().text());
    assert.equal((await archive.meta()).revision, initialRevision + (success && route === "photos" ? 1 : 0));
    assert.equal((await archive.db.prepare("SELECT count(*) AS n FROM media_originals").get())?.n,
      success ? 1 : 0);
    assert.equal((await archive.db.prepare("SELECT count(*) AS n FROM media_upload_grants").get())?.n,
      success && route === "portraits" ? 1 : 0);
    assert.equal(readdirSync(uploads).length, success ? 1 : 0);
    if (success) {
      const body = await response.json() as { url?: string; family?: { photos?: unknown[] } };
      if (route === "portraits") assert.match(body.url || "", /^\/media\//);
      else assert.equal(body.family?.photos?.length, 1);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const route of ["photos", "portraits"] as const)
  for (const scenario of ["logout", "expiry", "reader", "unapproved", "public success", "local success"] as const)
    test(`SQLite ${route} upload: ${scenario}`, async () => uploadScenario(route, scenario));
