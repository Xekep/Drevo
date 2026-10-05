import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveChanges } from "../src/domain/changes.ts";
import type { Family, Source } from "../src/domain/types.ts";
import { DEFAULT_STORAGE_LIMITS } from "../src/shared/storage-limits.ts";
import { createAuth } from "../src/server/auth.ts";
import { openArchive } from "../src/server/database.ts";
import { familyChangesHttp } from "../src/server/family-changes-http.ts";
import { registerMediaUpload } from "../src/server/media-access.ts";
import { newSessionToken, sessionTokenHash } from "../src/server/session-token.ts";
import { userStorageBytes } from "../src/server/storage-limits.ts";
import { userStore } from "../src/server/users.ts";

test("scoped author can undo removal of an own citation after upload grant release", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-citation-undo-red-"));
  const family: Family = { title: "Тест", description: "", demo: false,
    people: [{ id: "anchor", createdBy: "member", name: "Иван", surname: "Тестов",
      patronymic: "", sex: "m", birth: "", birthPlace: "", parents: [], spouses: [],
      generation: 1, column: 0, sources: [] },
    { id: "other", createdBy: "member", name: "Пётр", surname: "Тестов",
      patronymic: "", sex: "m", birth: "", birthPlace: "", parents: [], spouses: [],
      generation: 1, column: 1, sources: [] }] };
  const archive = await openArchive(join(directory, "archive.sqlite"), family);
  const users = await userStore(archive.db);
  await users.register("owner", "Владелец");
  await users.register("member", "Участник");
  await archive.db.prepare(`UPDATE users SET role='relative',approved=1,
    person_id='anchor',tree_access='common_ancestors' WHERE id='member'`).run();
  const origin = "https://archive.test";
  const auth = await createAuth(users, archive.db, origin);
  const token = newSessionToken();
  await archive.db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .run(sessionTokenHash(token), "member", Date.now() + 60_000);
  const handle = familyChangesHttp({ archive, auth, publicOrigin: origin });
  const server = createServer((req, res) => {
    void handle(req, res, new URL(req.url!, "http://localhost")).catch(() => {
      res.writeHead(500).end("Unexpected handler failure");
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = `/media/${randomUUID()}.pdf`;
    const source: Source = { title: "Свой документ", type: "архив", reference: "л. 1", url };
    await registerMediaUpload(archive.db, url, "member", 123);
    assert.equal(await userStorageBytes(archive.db, "member"), 123);
    const change = async (update: (family: Family) => void) => {
      const before = await archive.read();
      const after = structuredClone(before.family);
      update(after);
      const response = await fetch(`${base}/api/family/changes`, {
        method: "POST", headers: { Origin: origin, Cookie: `drevo_session=${token}`,
          "Content-Type": "application/json", "If-Match": String(before.revision) },
        body: JSON.stringify({ changes: archiveChanges(before.family, after) }),
      });
      return { response, before };
    };
    const added = await change((next) => { next.people[0].sources = [source]; });
    assert.equal(added.response.status, 200, await added.response.text());
    assert.equal(Number((await archive.db.prepare("SELECT count(*) AS n FROM media_upload_grants").get())?.n), 0);
    assert.equal((await archive.db.prepare("SELECT size_bytes FROM media_originals WHERE url=?")
      .get(url))?.size_bytes, 123);
    assert.equal(await userStorageBytes(archive.db, "member"), 123);
    const removed = await change((next) => { next.people[0].sources = []; });
    assert.equal(removed.response.status, 200, await removed.response.text());
    assert.deepEqual((await archive.readRevision(removed.before.revision)).people[0].sources, [source]);
    assert.equal(await userStorageBytes(archive.db, "member"), 0);
    const beforeRestore = await archive.read();
    const copied = await change((next) => { next.people[1].sources = [source]; });
    assert.equal(copied.response.status, 403, await copied.response.text());
    assert.deepEqual(await archive.read(), beforeRestore);
    const foreignUrl = `/media/${randomUUID()}.pdf`;
    await registerMediaUpload(archive.db, foreignUrl, "owner", 17);
    const foreign = await change((next) => { next.people[0].sources = [
      { ...source, url: foreignUrl }]; });
    assert.equal(foreign.response.status, 403, await foreign.response.text());
    assert.deepEqual(await archive.read(), beforeRestore);
    await archive.db.prepare(`INSERT INTO upload_limits(id,data) VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`)
      .run(JSON.stringify({ ...DEFAULT_STORAGE_LIMITS, relative: 0 }));
    const overQuota = await change((next) => { next.people[0].sources = [source]; });
    assert.equal(overQuota.response.status, 507, await overQuota.response.text());
    assert.deepEqual(await archive.read(), beforeRestore, "quota denial rolls back the undo");
    await archive.db.prepare("UPDATE upload_limits SET data=? WHERE id=1")
      .run(JSON.stringify(DEFAULT_STORAGE_LIMITS));
    const restored = await change((next) => { next.people[0].sources = [source]; });
    assert.equal(restored.response.status, 200, await restored.response.text());
    assert.equal(await userStorageBytes(archive.db, "member"), 123);
    const otherUrl = `/media/${randomUUID()}.pdf`;
    const otherSource: Source = { ...source, url: `${otherUrl}#page=3` };
    await registerMediaUpload(archive.db, otherUrl, "member", 29);
    const citedOther = await change((next) => { next.people[1].sources = [otherSource]; });
    assert.equal(citedOther.response.status, 200, await citedOther.response.text());
    assert.equal(Number((await archive.db.prepare("SELECT count(*) AS n FROM media_upload_grants WHERE url=?")
      .get(otherUrl))?.n), 0);
    const beforeDelete = await archive.read();
    const deletedOther = await change((next) => { next.people.splice(1, 1); });
    assert.equal(deletedOther.response.status, 403, await deletedOther.response.text());
    assert.deepEqual(await archive.read(), beforeDelete,
      "scoped participants cannot delete an own cited person for a later undo");
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
