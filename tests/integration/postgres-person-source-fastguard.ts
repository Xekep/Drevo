import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { openArchive } from "../../src/server/database.ts";
import { archiveChanges } from "../../src/domain/changes.ts";
import { sourceCatalogStore } from "../../src/server/source-catalog-store.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import type { CatalogSource } from "../../src/shared/source-catalog.ts";

type Archive = Awaited<ReturnType<typeof openArchive>>;

export async function verifyPersonSourceFastguard(
  archive: Archive, foreignArchive: Archive, base: string, origin: string,
) {
  const initial = await archive.read();
  const personId = initial.family.people[0]?.id;
  assert.ok(personId);
  const localId = `local-${randomUUID()}`;
  const foreignId = `foreign-${randomUUID()}`;
  const documentId = randomUUID();
  const otherDocumentId = randomUUID();
  const makeSource = (id: string, documentIds: string[]): CatalogSource => ({
    id, title: "Synthetic register", type: "archive", author: "",
    institution: "", archive: "", fond: "", opis: "", delo: "", sheet: "",
    reference: "leaf 1", url: "", accessedAt: "", description: "", documentIds,
  });
  const local = makeSource(localId, [documentId]);
  const foreign = makeSource(foreignId, []);
  const cite = (id = localId, doc = documentId) => ({ catalogId: id,
    title: "Synthetic register", type: "archive", reference: "leaf 1",
    documentId: doc, documentPage: 2 });
  const token = newSessionToken();
  const headers = { Origin: origin, Cookie: `drevo_session=${token}`,
    "Content-Type": "application/json" };
  const sourceStore = sourceCatalogStore(archive.db);
  const foreignStore = sourceCatalogStore(foreignArchive.db);
  try {
    for (const id of [documentId, otherDocumentId])
      await archive.db.prepare("",
        "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,document_date,place,description,provenance,annotations,event_links,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(id, "Synthetic scan", "synthetic scan", `${id}.pdf`, 1,
        "owner", "2026-01-01T00:00:00Z", "", "", "", "", "", "[]", "[]", "[]");
    await sourceStore.insert(local);
    await foreignStore.insert(foreign);
    await archive.db.prepare("",
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'owner',?)",
    ).run(sessionTokenHash(token), Date.now() + 60_000);
    const send = async (method: "POST" | "PUT", edit: (value: typeof initial.family) => void) => {
      const before = await archive.read();
      const next = structuredClone(before.family);
      edit(next);
      return fetch(base + (method === "POST" ? "/api/family/changes" : "/api/family"), {
        method, headers: { ...headers, "If-Match": String(before.revision) },
        body: JSON.stringify(method === "POST"
          ? { changes: archiveChanges(before.family, next) } : next),
      });
    };
    const valid = await send("POST", (value) => {
      value.people[0].sources.push(cite());
    });
    assert.equal(valid.status, 200, await valid.text());
    assert.equal((await archive.read()).family.people[0].sources.at(-1)?.documentId,
      documentId);
    for (const method of ["POST", "PUT"] as const) {
      const before = await archive.read();
      const count = (await archive.db.prepare("", "SELECT count(*) AS n FROM history").get())?.n;
      for (const [label, edit] of [
        ["missing catalog", (value: typeof initial.family) => {
          value.people[0].sources.push(cite("missing-register"));
        }],
        ["foreign catalog", (value: typeof initial.family) => {
          value.people[0].sources.push(cite(foreignId));
        }],
        ["unlinked document", (value: typeof initial.family) => {
          value.people[0].events ||= [];
          value.people[0].events.push({ id: "synthetic-move", type: "move",
            date: "1901", sources: [cite(localId, otherDocumentId)] });
        }],
      ] as const) {
        const response = await send(method, edit);
        assert.equal(response.status, 400, `${method} ${label}: ${await response.text()}`);
        assert.deepEqual(await archive.read(), before, `${label} must not change data/revision`);
        assert.equal((await archive.db.prepare("", "SELECT count(*) AS n FROM history").get())?.n,
          count, `${label} must not append history`);
      }
    }
    console.log("runtime_person_source_fastguard_ok");
  } finally {
    await archive.write(initial.family, (await archive.read()).revision);
    await archive.db.prepare("", "DELETE FROM account_sessions WHERE token_hash=?")
      .run(sessionTokenHash(token));
    await sourceStore.remove(localId, 1);
    await foreignStore.remove(foreignId, 1);
    await archive.db.prepare("", "DELETE FROM documents WHERE id=?").run(documentId);
    await archive.db.prepare("", "DELETE FROM documents WHERE id=?").run(otherDocumentId);
  }
}
