import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentsHttp } from "../src/server/documents-http.ts";
import { openArchive } from "../src/server/database.ts";
import { mediaStore } from "../src/server/media.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import { searchPeople } from "./fixtures/document-search.ts";

test("scoped original, range and conditional reads use minimal visibility and recheck delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-scoped-file-"));
  const archive = await openArchive(":memory:", {
    title: "Test", description: "", demo: false,
    people: searchPeople.map(person => ({ ...person, biography: "Heavy biography".repeat(1000) })),
  });
  const id = randomUUID(), hiddenId = randomUUID(), fileName = `${randomUUID()}.pdf`;
  const bytes = Buffer.from("%PDF-1.4\nsynthetic private original");
  await writeFile(join(directory, fileName), bytes);
  let user: ArchiveUser = {
    id: "reader", name: "Reader", role: "reader", approved: true, createdAt: "",
    treeAccess: "common_ancestors", personId: searchPeople[0].id,
  };
  for (const document of [id, hiddenId]) {
    await archive.db.prepare(
      "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(document, "Document", "document", document === id ? fileName : `${randomUUID()}.pdf`, bytes.length, "other", "2026-11-04");
    await archive.db.prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)")
      .run(document, document === id ? searchPeople[0].id : searchPeople[1].id);
  }
  archive.read = async () => { throw new Error("File authorization must not load the full archive"); };
  let beforeDelivery: (() => Promise<void>) | undefined;
  const handler = documentsHttp({
    archive, uploadsDirectory: directory, media: mediaStore(directory),
    auth: { canRead: async () => true, currentUser: async () => user } as unknown as Awaited<ReturnType<typeof createAuth>>,
    beforeFileDelivery: async () => { await beforeDelivery?.(); },
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://localhost"))
      .catch(error => { res.writeHead(500).end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/documents`;
  try {
    const original = await fetch(`${base}/${id}/file`);
    assert.equal(original.status, 200, await original.clone().text());
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    const etag = original.headers.get("etag");
    assert.ok(etag);
    const range = await fetch(`${base}/${id}/file`, { headers: { Range: "bytes=0-7" } });
    assert.equal(range.status, 206, await range.clone().text());
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 8));
    const conditional = await fetch(`${base}/${id}/file`, { headers: { "If-None-Match": etag } });
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
    const hidden = await fetch(`${base}/${hiddenId}/file`, { headers: { Range: "bytes=0-7" } });
    assert.equal(hidden.status, 404);
    assert.doesNotMatch(await hidden.text(), /%PDF/);

    for (const headers of [{ Range: "bytes=0-7" }, { "If-None-Match": etag }] as Record<string, string>[]) {
      beforeDelivery = async () => { await archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run(); };
      const changed = await fetch(`${base}/${id}/file`, { headers });
      assert.equal(changed.status, 404, "a revision changed after preparing IDs cannot authorize bytes or 304");
      assert.equal(changed.headers.get("content-range"), null);
      assert.doesNotMatch(await changed.text(), /%PDF/);
    }
    beforeDelivery = async () => { await archive.db.prepare("DELETE FROM document_people WHERE document_id=?").run(id); };
    const unlinked = await fetch(`${base}/${id}/file`, { headers: { Range: "bytes=0-7" } });
    assert.equal(unlinked.status, 404);
    assert.doesNotMatch(await unlinked.text(), /%PDF/);
    await archive.db.prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)").run(id, user.personId!);
    beforeDelivery = async () => { user = { ...user, approved: false }; };
    const revoked = await fetch(`${base}/${id}/file`, { headers: { "If-None-Match": etag } });
    assert.equal(revoked.status, 404);
    assert.doesNotMatch(await revoked.text(), /%PDF/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await handler.close();
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});
