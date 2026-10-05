import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Client } from "pg";
import { openArchive } from "../../src/server/database.ts";
import type { createAuth } from "../../src/server/auth.ts";
import { createAuth as makeAuth } from "../../src/server/auth.ts";
import { userStore } from "../../src/server/users.ts";
import { faceDescriptorsHttp } from "../../src/server/face-descriptors-http.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";

type Archive = Awaited<ReturnType<typeof openArchive>>;
type Auth = Awaited<ReturnType<typeof createAuth>>;

function gate() {
  let entered!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => { entered = resolve; }),
    release: new Promise<void>((resolve) => { release = resolve; }),
    notify: () => entered(),
    open: () => release(),
  };
}

async function serve(archive: Archive, origin: string, auth: Auth) {
  const handler = faceDescriptorsHttp({ archive, auth, publicOrigin: origin });
  const server = createServer(async (req, res) => {
    try {
      if (!await handler(req, res, new URL(req.url || "/", "http://localhost")))
        res.writeHead(404).end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy(error as Error);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function waitForGate(entered: Promise<void>, response: Promise<Response>) {
  let atGate = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered.then(() => { atGate = true; }),
      response.then(async (result) => {
        if (atGate) return;
        throw new Error(`Face request finished before gate: ${result.status} ${await result.text()}`);
      }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(
        "Face request did not reach the expected gate within 10 seconds")), 10_000); }),
    ]);
  } finally { clearTimeout(timeout); }
}

/** No mocked approval: each request uses a real account session and member. */
export async function verifyFaceSessionMutation(archive: Archive, client: Client,
  origin: string, source: string) {
  const db = archive.db;
  assert.equal(db.kind, "postgres");
  const priorScope = (await client.query<{ scope: string | null }>(
    "SELECT current_setting('drevo.archive_id',true) AS scope")).rows[0].scope;
  await client.query("SELECT set_config('drevo.archive_id',$1,false)", [db.archiveId]);
  const id = "face-session-delete";
  const token = newSessionToken();
  const hash = sessionTokenHash(token);
  const replacementHash = sessionTokenHash(newSessionToken());
  const headers = { Cookie: `drevo_session=${token}`, Origin: origin,
    "Content-Type": "application/json" };
  const descriptor = async () => db.prepare("", "SELECT created_by FROM face_descriptors WHERE id=?").get(id);
  const insert = async (author = "owner") => db.prepare("", `INSERT INTO face_descriptors
    (id,person_id,data,created_by,model) VALUES(?,'person-a','[]'::jsonb,?,'face-api-1.7.15')`)
    .run(id, author);
  const reset = async (author = "owner") => {
    await db.prepare("", "DELETE FROM face_descriptors WHERE id=?").run(id);
    await insert(author);
  };
  const realAuth = await makeAuth(await userStore(db), db, origin);
  await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
    VALUES($1,'owner',$2)`, [hash, Date.now() + 60_000]);
  try {
    for (const revoke of ["logout", "membership"] as const) {
      await reset();
      const waiting = gate();
      let calls = 0;
      const auth = { ...realAuth, currentUser: async (...args: Parameters<Auth["currentUser"]>) => {
        const user = await realAuth.currentUser(...args);
        if (++calls === 2) { waiting.notify(); await waiting.release; }
        return user;
      } } as Auth;
      const http = await serve(archive, origin, auth);
      try {
        const pending = fetch(`${http.base}/api/faces/descriptors/${id}`,
          { method: "DELETE", headers });
        await waitForGate(waiting.entered, pending);
        if (revoke === "logout") {
          await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
          await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
            VALUES($1,'owner',$2)`, [replacementHash, Date.now() + 60_000]);
        } else
          assert.equal((await client.query(`UPDATE archive_memberships SET approved=false
            WHERE archive_id=$1 AND user_id='owner'`, [db.archiveId])).rowCount, 1);
        waiting.open();
        const response = await pending;
        assert.equal(response.status, revoke === "logout" ? 401 : 403,
          `${revoke} completed before the final descriptor check`);
        assert.ok(await descriptor(), `${revoke} must retain the row`);
      } finally {
        waiting.open();
        await http.close();
        if (revoke === "logout")
          await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
            VALUES($1,'owner',$2)`, [hash, Date.now() + 60_000]);
        else
          await client.query(`UPDATE archive_memberships SET approved=true
            WHERE archive_id=$1 AND user_id='owner'`, [db.archiveId]);
      }
    }

    // A previous canEdit result is not an actor snapshot. Logout or member
    // revocation may finish before the first lookup, or while SAVE reads JSON.
    for (const stage of ["preflight", "saveBody"] as const) {
      for (const revoke of ["logout", "membership"] as const) {
        await reset();
        const waiting = gate();
        let calls = 0;
        const auth = { ...realAuth, currentUser: async (...args: Parameters<Auth["currentUser"]>) => {
          if (++calls === (stage === "preflight" ? 1 : 2)) {
            waiting.notify();
            await waiting.release;
          }
          return realAuth.currentUser(...args);
        } } as Auth;
        const http = await serve(archive, origin, auth);
        const sampleId = `face-session-${stage}-${revoke}`;
        try {
          const pending = stage === "preflight"
            ? fetch(`${http.base}/api/faces/descriptors/${id}`, { method: "DELETE", headers })
            : fetch(`${http.base}/api/faces/descriptors`, {
              method: "POST", headers,
              body: JSON.stringify({ id: sampleId, personId: "person-a",
                sourcePhotoId: "face-session-source", sourceTagId: "tag",
                model: "face-api-1.7.15", descriptor: Array(128).fill(0) }),
            });
          await waitForGate(waiting.entered, pending);
          if (revoke === "logout")
            await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
          else
            assert.equal((await client.query(`UPDATE archive_memberships SET approved=false
              WHERE archive_id=$1 AND user_id='owner'`, [db.archiveId])).rowCount, 1);
          waiting.open();
          const response = await pending;
          assert.equal(response.status, revoke === "logout" ? 401 : 403,
            `${stage}/${revoke}: ${await response.text()}`);
          assert.ok(await descriptor());
          assert.equal(await db.prepare("", "SELECT id FROM face_descriptors WHERE id=?")
            .get(sampleId), undefined);
        } finally {
          waiting.open();
          await http.close();
          if (revoke === "logout")
            await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
              VALUES($1,'owner',$2)`, [hash, Date.now() + 60_000]);
          else
            await client.query(`UPDATE archive_memberships SET approved=true
              WHERE archive_id=$1 AND user_id='owner'`, [db.archiveId]);
        }
      }
    }

    // A descriptor with the same ID may be replaced while an earlier request
    // is waiting. The old author's snapshot cannot authorize its deletion.
    const editorToken = newSessionToken();
    const editorHash = sessionTokenHash(editorToken);
    const editorRole = String((await client.query(`SELECT role FROM archive_memberships
      WHERE archive_id=$1 AND user_id='vk:42'`, [db.archiveId])).rows[0].role);
    assert.equal((await client.query(`UPDATE archive_memberships SET role='relative'
      WHERE archive_id=$1 AND user_id='vk:42'`, [db.archiveId])).rowCount, 1);
    await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES($1,'vk:42',$2)`, [editorHash, Date.now() + 60_000]);
    try {
      await reset("vk:42");
      const waiting = gate();
      let calls = 0;
      const auth = { ...realAuth, currentUser: async (...args: Parameters<Auth["currentUser"]>) => {
        const user = await realAuth.currentUser(...args);
        if (++calls === 2) { waiting.notify(); await waiting.release; }
        return user;
      } } as Auth;
      const http = await serve(archive, origin, auth);
      try {
        const pending = fetch(`${http.base}/api/faces/descriptors/${id}`, {
          method: "DELETE", headers: { ...headers, Cookie: `drevo_session=${editorToken}` },
        });
        await waitForGate(waiting.entered, pending);
        await reset("owner");
        waiting.open();
        assert.equal((await pending).status, 403);
        assert.equal((await descriptor())?.created_by, "owner");
      } finally { waiting.open(); await http.close(); }
      const editorTier = (await client.query<{ full_access: boolean }>(
        "SELECT full_access FROM account_tiers WHERE account_id='vk:42'"))
        .rows[0].full_access;
      await client.query("UPDATE account_tiers SET full_access=false WHERE account_id='vk:42'");
      try {
        await reset("vk:42");
        const lowerTierHttp = await serve(archive, origin, realAuth);
        try {
          assert.equal((await fetch(`${lowerTierHttp.base}/api/faces/descriptors/${id}`, {
            method: "DELETE", headers: { ...headers,
              Cookie: `drevo_session=${editorToken}` },
          })).status, 200, "a non-owner can remove their own sample after AI downgrade");
          assert.equal(await descriptor(), undefined);
        } finally { await lowerTierHttp.close(); }
      } finally {
        await client.query("UPDATE account_tiers SET full_access=$1 WHERE account_id='vk:42'",
          [editorTier]);
      }
      await client.query(`UPDATE archive_memberships SET role='reader'
        WHERE archive_id=$1 AND user_id='vk:42'`, [db.archiveId]);
      await reset("vk:42");
      const readOnlyHttp = await serve(archive, origin, realAuth);
      try {
        assert.equal((await fetch(`${readOnlyHttp.base}/api/faces/descriptors/${id}`, {
          method: "DELETE", headers: { ...headers,
            Cookie: `drevo_session=${editorToken}` },
        })).status, 403, "a local reader still cannot delete an own sample");
        assert.equal((await descriptor())?.created_by, "vk:42");
      } finally { await readOnlyHttp.close(); }
    } finally {
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [editorHash]);
      await client.query(`UPDATE archive_memberships SET role=$1
        WHERE archive_id=$2 AND user_id='vk:42'`, [editorRole, db.archiveId]);
    }
    // Tier downgrade removes matching/saving, but not the ability to delete
    // one's own already-stored biometric sample.
    const previousTier = (await client.query<{ full_access: boolean }>(
      "SELECT full_access FROM account_tiers WHERE account_id='owner'"))
      .rows[0]?.full_access;
    assert.equal(previousTier, true, "SAVE expiry checks require a full-tier owner");
    await reset();
    await client.query("UPDATE account_tiers SET full_access=false WHERE account_id='owner'");
    try {
      const http = await serve(archive, origin, realAuth);
      try {
        const deniedSave = await fetch(`${http.base}/api/faces/descriptors`, {
          method: "POST", headers,
          body: JSON.stringify({ id: "face-session-disabled", personId: "person-a",
            sourcePhotoId: "face-session-source", sourceTagId: "tag",
            model: "face-api-1.7.15", descriptor: Array(128).fill(0) }),
        });
        assert.equal(deniedSave.status, 403);
        const deleted = await fetch(`${http.base}/api/faces/descriptors/${id}`,
          { method: "DELETE", headers });
        assert.equal(deleted.status, 200);
        assert.equal(await descriptor(), undefined);
      } finally { await http.close(); }
    } finally {
      await client.query("UPDATE account_tiers SET full_access=$1 WHERE account_id='owner'",
        [previousTier]);
    }

    // The session is live at admission but expires while SAVE waits on its
    // person row. The final clock check must roll back the inserted sample.
    const saveId = "face-session-expired-save";
    const photoId = "face-session-source";
    const tagId = `${photoId}:tag`;
    await db.prepare("", "INSERT INTO photos(id,data) VALUES(?,?::jsonb)")
      .run(photoId, JSON.stringify({ id: photoId, createdBy: "owner", url: "/media/synthetic.jpg" }));
    await db.prepare("", `INSERT INTO photo_tags(id,photo_id,person_id,data)
      VALUES(?,?,'person-a',?::jsonb)`)
      .run(tagId, photoId, JSON.stringify({ id: "tag", personId: "person-a",
        x: 0, y: 0, width: 1, height: 1 }));
    const originalPrepare = db.prepare;
    const basePrepare = originalPrepare.bind(db);
    try {
      for (const boundary of ["person", "tag"] as const) {
        const expiringToken = newSessionToken();
        const expiringHash = sessionTokenHash(expiringToken);
        const waiting = gate();
        const sampleId = `${saveId}-${boundary}`;
        try {
          await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
            VALUES($1,'owner',$2)`, [expiringHash, Date.now() + 3000]);
          db.prepare = (sqlite, postgres) => {
            const statement = basePrepare(sqlite, postgres);
            const held = boundary === "person"
              ? postgres === "SELECT id FROM people WHERE id=? FOR UPDATE"
              : postgres?.includes("FOR SHARE OF photos,photo_tags");
            if (!held) return statement;
            return { ...statement, get: async (...values) => {
              waiting.notify();
              await waiting.release;
              return statement.get(...values);
            } };
          };
          const http = await serve(archive, origin, realAuth);
          try {
            const pending = fetch(`${http.base}/api/faces/descriptors`, {
              method: "POST", headers: { ...headers,
                Cookie: `drevo_session=${expiringToken}` },
              body: JSON.stringify({ id: sampleId, personId: "person-a",
                sourcePhotoId: photoId, sourceTagId: "tag", model: "face-api-1.7.15",
                descriptor: Array(128).fill(0) }),
            });
            await waitForGate(waiting.entered, pending);
            const expiresAt = Number((await client.query(
              "SELECT expires_at FROM account_sessions WHERE token_hash=$1", [expiringHash],
            )).rows[0].expires_at);
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 30)));
            waiting.open();
            const response = await pending;
            assert.equal(response.status, 401, await response.text());
            assert.equal(await basePrepare("", "SELECT id FROM face_descriptors WHERE id=?")
              .get(sampleId), undefined);
          } finally { waiting.open(); await http.close(); }
        } finally {
          db.prepare = originalPrepare;
          await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [expiringHash]);
          await db.prepare("", "DELETE FROM face_descriptors WHERE id=?").run(sampleId);
        }
      }
    } finally {
      db.prepare = originalPrepare;
      await db.prepare("", "DELETE FROM photo_tags WHERE id=?").run(tagId);
      await db.prepare("", "DELETE FROM photos WHERE id=?").run(photoId);
    }
    const neighborId = "face-session-other";
    const neighborFamily = (await archive.read()).family;
    const neighborPerson = neighborFamily.people.find((person) => person.id === "person-a");
    assert.ok(neighborPerson);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [neighborId]);
    try {
      await client.query(`INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version)
        VALUES($1,'Synthetic face archive','',false,1,18)`, [neighborId]);
      await client.query(`INSERT INTO people(archive_id,id,ordinal,data)
        VALUES($1,'person-a',1,$2::jsonb)`, [neighborId, JSON.stringify(neighborPerson)]);
    } finally {
      await client.query("SELECT set_config('drevo.archive_id',$1,false)", [db.archiveId]);
    }
    const neighbor = await openArchive(source, neighborFamily, neighborId);
    try {
      await neighbor.db.prepare("", `INSERT INTO face_descriptors
        (id,person_id,data,created_by) VALUES(?,'person-a','[]'::jsonb,'owner')`)
        .run(id);
      await reset();
      const http = await serve(archive, origin, realAuth);
      try {
        assert.equal((await fetch(`${http.base}/api/faces/descriptors/${id}`,
          { method: "DELETE", headers })).status, 200);
        assert.equal(await descriptor(), undefined);
        assert.ok(await neighbor.db.prepare("", "SELECT id FROM face_descriptors WHERE id=?")
          .get(id), "the same local ID in another archive is untouched under RLS");
      } finally { await http.close(); }
    } finally {
      await neighbor.db.prepare("", `DELETE FROM archives
        WHERE id=current_setting('drevo.archive_id',true)`).run();
      await neighbor.close();
    }
    console.log("runtime_face_session_mutations_ok");
  } finally {
    await db.prepare("", "DELETE FROM face_descriptors WHERE id=?").run(id);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [replacementHash]);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [priorScope || ""]);
  }
}
