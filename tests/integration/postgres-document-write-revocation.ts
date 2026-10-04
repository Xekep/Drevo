import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import pg, { type Client } from "pg";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import type { openArchive } from "../../src/server/database.ts";
import { createAuth } from "../../src/server/auth.ts";
import { userStore } from "../../src/server/users.ts";
import { mediaStore } from "../../src/server/media.ts";
import { documentsHttp } from "../../src/server/documents-http.ts";

/** A completed logout cannot race past the last document-write check. */
export async function verifyDocumentWriteSessionRevocation(
  archive: Awaited<ReturnType<typeof openArchive>>,
  client: Client,
  base: string,
  origin: string,
  uploadsDirectory: string,
) {
  const id = randomUUID();
  const originalPath = join(uploadsDirectory, `${id}.pdf`);
  const token = newSessionToken();
  const hash = sessionTokenHash(token);
  const revokedFirstToken = newSessionToken();
  const revokedFirstHash = sessionTokenHash(revokedFirstToken);
  const handoffToken = newSessionToken();
  const handoffHash = sessionTokenHash(handoffToken);
  const expiryToken = newSessionToken();
  const expiryHash = sessionTokenHash(expiryToken);
  const scenarioHashes: string[] = [];
  const blocker = new pg.Client();
  await blocker.connect();
  let blocking = false;
  const original = {
    title: "Synthetic register",
    documentType: "",
    documentDate: "",
    place: "",
    description: "",
    provenance: "",
  };
  const next = { ...original, title: "Synthetic revised register" };
  try {
    await writeFile(originalPath, "%PDF-1.4\n");
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await blocker.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await client.query(
      `INSERT INTO documents(archive_id,id,ordinal,title,title_search,file_name,file_size,uploaded_by,created_at)
       VALUES('runtime-test',$1,(SELECT COALESCE(max(ordinal),0)+1 FROM documents WHERE archive_id='runtime-test'),
         $2,'synthetic register',$3,9,'owner',now())`,
      [id, original.title, `${id}.pdf`],
    );
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
      [hash, Date.now() + 600_000],
    );
    await blocker.query("BEGIN");
    blocking = true;
    assert.equal((await blocker.query("SELECT id FROM documents WHERE id=$1 FOR UPDATE", [id])).rowCount, 1);
    const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const changing = fetch(`${base}/api/documents/${id}`, {
      method: "PATCH",
      headers: {
        Cookie: `drevo_session=${token}`,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expected: original, next }),
    });
    for (let attempt = 0; attempt < 150; attempt++) {
      const waiting = await client.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
           WHERE datname=current_database() AND wait_event_type='Lock'
             AND $1=ANY(pg_blocking_pids(pid))
             AND query LIKE 'UPDATE documents SET title=%') AS blocked`,
        [blockerPid],
      );
      if (waiting.rows[0].blocked) break;
      if (attempt === 149) throw new Error("Document PATCH did not reach its blocked UPDATE");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    let revoked = false;
    const revoke = client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash])
      .then((result) => { revoked = result.rowCount === 1; });
    await Promise.race([revoke, new Promise((resolve) => setTimeout(resolve, 250))]);
    assert.equal(revoked, false,
      "a completed logout must wait for the accepted document mutation to commit");
    await blocker.query("COMMIT");
    blocking = false;
    const response = await changing;
    assert.equal(response.status, 200, await response.clone().text());
    await revoke;
    const row = (await client.query<{ title: string }>(
      "SELECT title FROM documents WHERE id=$1", [id],
    )).rows[0];
    assert.equal(row.title, next.title);
    const denied = await fetch(`${base}/api/documents/${id}`, {
      method: "PATCH",
      headers: { Cookie: `drevo_session=${token}`, Origin: origin,
        "Content-Type": "application/json" },
      body: JSON.stringify({ expected: next, next: original }),
    });
    assert.notEqual(denied.status, 200, "a completed logout blocks the next write");
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
      [revokedFirstHash, Date.now() + 600_000],
    );
    await blocker.query("BEGIN");
    blocking = true;
    assert.equal((await blocker.query(
      "SELECT id FROM archives WHERE id='runtime-test' FOR UPDATE",
    )).rowCount, 1);
    const delayed = fetch(`${base}/api/documents/${id}`, {
      method: "PATCH",
      headers: { Cookie: `drevo_session=${revokedFirstToken}`, Origin: origin,
        "Content-Type": "application/json" },
      body: JSON.stringify({ expected: next, next: original }),
    });
    for (let attempt = 0; attempt < 150; attempt++) {
      const waiting = await client.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND $1=ANY(pg_blocking_pids(pid))
            AND query LIKE 'SELECT id FROM archives WHERE id=%') AS blocked`,
        [blockerPid],
      );
      if (waiting.rows[0].blocked) break;
      if (attempt === 149) throw new Error("Document PATCH did not reach the archive lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await client.query(
      "DELETE FROM account_sessions WHERE token_hash=$1", [revokedFirstHash],
    )).rowCount, 1, "logout completes before the final document check");
    await blocker.query("COMMIT");
    blocking = false;
    const refused = await delayed;
    assert.ok([401, 403].includes(refused.status), await refused.clone().text());
    assert.equal((await client.query<{ title: string }>(
      "SELECT title FROM documents WHERE id=$1", [id],
    )).rows[0].title, next.title);
    // The full server renews near-expiry sessions before dispatch. Exercise
    // the document handler directly to hold an unchanged short-lived session.
    const expiryAuth = await createAuth(await userStore(archive.db), archive.db, origin);
    const expiryHandler = documentsHttp({ archive, auth: expiryAuth,
      media: mediaStore(uploadsDirectory), uploadsDirectory, publicOrigin: origin });
    const expiryServer = createServer((req, res) => {
      void expiryHandler(req, res, new URL(req.url || "/", "http://localhost"))
        .then((handled) => { if (!handled) res.writeHead(404).end(); })
        .catch((error) => { if (!res.headersSent) res.writeHead(500).end(String(error)); });
    });
    await new Promise<void>((resolve) => expiryServer.listen(0, "127.0.0.1", resolve));
    const expiryBase = `http://127.0.0.1:${(expiryServer.address() as { port: number }).port}`;
    try {
      const expiresAt = Date.now() + 3_000;
      await client.query(
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
        [expiryHash, expiresAt],
      );
      await blocker.query("BEGIN");
      blocking = true;
      assert.equal((await blocker.query(
        "SELECT id FROM documents WHERE id=$1 FOR UPDATE", [id],
      )).rowCount, 1);
      const expiring = fetch(`${expiryBase}/api/documents/${id}`, {
        method: "PATCH",
        headers: { Cookie: `drevo_session=${expiryToken}`, Origin: origin,
          "Content-Type": "application/json" },
        body: JSON.stringify({ expected: next, next: original }),
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await client.query<{ blocked: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND $1=ANY(pg_blocking_pids(pid))
              AND query LIKE 'UPDATE documents SET title=%') AS blocked`,
          [blockerPid],
        );
        if (waiting.rows[0].blocked) break;
        if (attempt === 99) throw new Error("Expiring PATCH did not reach its blocked UPDATE");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve,
        Math.max(0, expiresAt - Date.now() + 200)));
      assert.ok(Date.now() >= expiresAt,
        "the held document write continues after its issuing session expires");
      await blocker.query("COMMIT");
      blocking = false;
      const expired = await expiring;
      assert.equal(expired.status, 401, await expired.clone().text());
      assert.equal((await client.query<{ title: string }>(
        "SELECT title FROM documents WHERE id=$1", [id],
      )).rows[0].title, next.title,
      "expiry after the first session check rolls the entire document write back");
    } finally {
      if (blocking) { await blocker.query("ROLLBACK"); blocking = false; }
      await new Promise<void>((resolve) => expiryServer.close(() => resolve()));
    }
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
      [handoffHash, Date.now() + 600_000],
    );
    let entered!: () => void;
    let release!: () => void;
    const atHandoff = new Promise<void>((resolve) => { entered = resolve; });
    const holdHandoff = new Promise<void>((resolve) => { release = resolve; });
    const auth = await createAuth(await userStore(archive.db), archive.db, origin);
    const handler = documentsHttp({ archive, auth, media: mediaStore(uploadsDirectory),
      uploadsDirectory, publicOrigin: origin,
      beforeMetadataDelivery: async () => { entered(); await holdHandoff; },
    });
    const handoffServer = createServer((req, res) => {
      void handler(req, res, new URL(req.url || "/", "http://localhost"))
        .then((handled) => { if (!handled) res.writeHead(404).end(); })
        .catch((error) => { if (!res.headersSent) res.writeHead(500).end(String(error)); });
    });
    await new Promise<void>((resolve) => handoffServer.listen(0, "127.0.0.1", resolve));
    try {
      const handoffBase = `http://127.0.0.1:${(handoffServer.address() as { port: number }).port}`;
      const writing = fetch(`${handoffBase}/api/documents/${id}`, {
        method: "PATCH",
        headers: { Cookie: `drevo_session=${handoffToken}`, Origin: origin,
          "Content-Type": "application/json" },
        body: JSON.stringify({ expected: next, next: original }),
      });
      await Promise.race([atHandoff, new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Committed document delivery did not reach gate")), 5_000))]);
      assert.equal((await client.query<{ title: string }>(
        "SELECT title FROM documents WHERE id=$1", [id],
      )).rows[0].title, original.title, "document write committed before JSON handoff");
      assert.equal((await client.query(
        "DELETE FROM account_sessions WHERE token_hash=$1", [handoffHash],
      )).rowCount, 1, "logout completed after commit but before the private response");
      release();
      const result = await writing;
      assert.equal(result.status, 200, "a committed write must not be reported as rolled back");
      const body = await result.text();
      assert.deepEqual(JSON.parse(body), { committed: true, accessChanged: true });
      assert.doesNotMatch(body, /Synthetic register|Synthetic revised register|file_name/);
    } finally {
      release();
      await new Promise<void>((resolve) => handoffServer.close(() => resolve()));
    }
    for (const scenario of [
      { method: "POST", path: `/api/documents/${id}/annotations`,
        body: { page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.2,
          text: "Synthetic annotation" },
        query: "UPDATE documents SET annotations=%", status: 201 },
      { method: "DELETE", path: `/api/documents/${id}`,
        body: null, query: "DELETE FROM documents WHERE id=%", status: 200 },
    ]) {
      const scenarioToken = newSessionToken();
      const scenarioHash = sessionTokenHash(scenarioToken);
      scenarioHashes.push(scenarioHash);
      await client.query(
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
        [scenarioHash, Date.now() + 600_000],
      );
      await blocker.query("BEGIN");
      blocking = true;
      assert.equal((await blocker.query(
        "SELECT id FROM documents WHERE id=$1 FOR UPDATE", [id],
      )).rowCount, 1);
      const writing = fetch(`${base}${scenario.path}`, {
        method: scenario.method,
        headers: { Cookie: `drevo_session=${scenarioToken}`, Origin: origin,
          "Content-Type": "application/json" },
        ...(scenario.body ? { body: JSON.stringify(scenario.body) } : {}),
      });
      for (let attempt = 0; attempt < 150; attempt++) {
        const waiting = await client.query<{ blocked: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
             WHERE datname=current_database() AND wait_event_type='Lock'
               AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2) AS blocked`,
          [blockerPid, scenario.query],
        );
        if (waiting.rows[0].blocked) break;
        if (attempt === 149) throw new Error(`${scenario.method} did not reach its blocked document write`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      let revoked = false;
      const revoke = client.query("DELETE FROM account_sessions WHERE token_hash=$1", [scenarioHash])
        .then((result) => { revoked = result.rowCount === 1; });
      await Promise.race([revoke, new Promise((resolve) => setTimeout(resolve, 250))]);
      assert.equal(revoked, false, `${scenario.method} holds the issuing session until commit`);
      await blocker.query("COMMIT");
      blocking = false;
      const response = await writing;
      assert.equal(response.status, scenario.status, await response.clone().text());
      await revoke;
    }
    assert.equal((await client.query("SELECT id FROM documents WHERE id=$1", [id])).rowCount,
      0, "the authorized DELETE completes once before its concurrent logout");
    assert.equal((await client.query(
      "SELECT current_setting('drevo.archive_id') AS id",
    )).rows[0].id, "runtime-test", "the shared runtime client's archive scope is retained");
    console.log("runtime_document_write_session_revocation_ok");
  } finally {
    if (blocking) await blocker.query("ROLLBACK");
    await blocker.end();
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [revokedFirstHash]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [handoffHash]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [expiryHash]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=ANY($1::text[])",
      [scenarioHashes]);
    await client.query("DELETE FROM documents WHERE id=$1", [id]);
    await unlink(originalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
