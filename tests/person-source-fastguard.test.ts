import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { createAuth } from "../src/server/auth.ts";
import { familyChangesHttp } from "../src/server/family-changes-http.ts";
import { userStore } from "../src/server/users.ts";
import { sourceCatalogStore } from "../src/server/source-catalog-store.ts";
import { newSessionToken, sessionTokenHash } from "../src/server/session-token.ts";
import { archiveChanges } from "../src/domain/changes.ts";
import type { Family, Source } from "../src/domain/types.ts";
import type { CatalogSource } from "../src/shared/source-catalog.ts";

const documentId = "11111111-1111-4111-8111-111111111111";
const unlinkedDocumentId = "22222222-2222-4222-8222-222222222222";
const catalog: CatalogSource = {
  id: "local-register", title: "Local register", type: "archive", author: "",
  institution: "", archive: "", fond: "", opis: "", delo: "", sheet: "",
  reference: "leaf 1", url: "", accessedAt: "", description: "",
  documentIds: [documentId],
};
const citation = (): Source => ({ catalogId: catalog.id, title: catalog.title,
  type: catalog.type, reference: catalog.reference, documentId, documentPage: 2 });
const family = (): Family => ({ title: "Synthetic", description: "", demo: false,
  people: [{ id: "person", name: "Person", surname: "Example", patronymic: "",
    sex: "u", birth: "1880", birthPlace: "", parents: [], spouses: [],
    generation: 1, column: 0, sources: [], createdBy: "relative",
    events: [{ id: "event", type: "move", date: "1901", place: "Town",
      sources: [] }] }],
});

test("HTTP card source and event changes use full catalog and evidence policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-person-source-guard-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const origin = "http://source-guard.invalid";
  const users = await userStore(app.archive.db);
  const tokens = new Map<string, string>();
  const endpoint = familyChangesHttp({ archive: app.archive,
    auth: await createAuth(users, app.archive.db, origin), publicOrigin: origin });
  const server = createServer((req, res) => {
    void endpoint(req, res, new URL(req.url!, "http://localhost")).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  try {
    await app.archive.write(family(), (await app.archive.read()).revision);
    for (const [id, role] of [["owner", "admin"], ["relative", "relative"]] as const) {
      await users.register(id, id);
      await app.archive.db.prepare("UPDATE users SET role=?,approved=1 WHERE id=?")
        .run(role, id);
      const token = newSessionToken();
      tokens.set(id, token);
      await app.archive.db.prepare(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      ).run(sessionTokenHash(token), id, Date.now() + 60_000);
    }
    for (const id of [documentId, unlinkedDocumentId])
      await app.archive.db.prepare(
        "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,document_date,place,description,provenance,annotations,event_links,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(id, "Scan", "scan", `${id}.pdf`, 1, "owner", "2026-01-01T00:00:00Z",
        "", "", "", "", "", "[]", "[]", "[]");
    await sourceCatalogStore(app.archive.db).insert(catalog);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const send = async (actor: string, method: "POST" | "PUT", next: Family) => {
      const before = await app.archive.read();
      return fetch(base + (method === "POST" ? "/api/family/changes" : "/api/family"), {
        method, headers: { Origin: origin, Cookie: `drevo_session=${tokens.get(actor)}`,
          "Content-Type": "application/json", "If-Match": String(before.revision) },
        body: JSON.stringify(method === "POST"
          ? { changes: archiveChanges(before.family, next) } : next),
      });
    };
    const unchangedAfter = async (actor: string, method: "POST" | "PUT",
      edit: (next: Family) => void, expected: number) => {
      const before = await app.archive.read();
      const history = (await app.archive.db.prepare("SELECT count(*) AS n FROM history").get())?.n;
      const next = structuredClone(before.family);
      edit(next);
      const response = await send(actor, method, next);
      assert.equal(response.status, expected, await response.text());
      assert.deepEqual(await app.archive.read(), before);
      assert.equal((await app.archive.db.prepare("SELECT count(*) AS n FROM history").get())?.n,
        history, "a rejected citation or event must not append history");
    };

    const valid = structuredClone((await app.archive.read()).family);
    valid.people[0].sources.push(citation());
    assert.equal((await send("owner", "POST", valid)).status, 200,
      "an owner may attach a local catalog citation and linked document");
    assert.equal((await app.archive.read()).family.people[0].sources[0].documentId,
      documentId);
    const validEvent = structuredClone((await app.archive.read()).family);
    validEvent.people[0].events![0].sources = [citation()];
    assert.equal((await send("owner", "POST", validEvent)).status, 200,
      "an owner may cite an event with a local catalog document");
    assert.equal((await app.archive.read()).family.people[0].events![0].sources?.[0].documentId,
      documentId);

    for (const method of ["POST", "PUT"] as const) {
      await unchangedAfter("owner", method, (next) => {
        next.people[0].sources.push({ ...citation(), catalogId: "missing-register" });
      }, 400);
      await unchangedAfter("owner", method, (next) => {
        next.people[0].events![0].sources = [{ ...citation(), documentId: unlinkedDocumentId }];
      }, 400);
      await unchangedAfter("relative", method, (next) => {
        next.people[0].sources.push(citation());
      }, 403);
    }
    await unchangedAfter("relative", "POST", (next) => {
      next.people[0].events![0].sources!.push(citation());
    }, 403);
    await unchangedAfter("relative", "POST", (next) => {
      next.people[0].events!.push({ id: "new-event", type: "move",
        date: "1902", sources: [next.people[0].sources.pop()!] });
    }, 403);
    await unchangedAfter("relative", "POST", (next) => {
      next.people[0].sources[0].title = "Altered catalog title";
    }, 403);
    await unchangedAfter("owner", "POST", (next) => {
      next.people[0].events![0].type = "military";
    }, 403);

    const assessed = structuredClone((await app.archive.read()).family);
    assessed.people[0].events![0].dateClaim = { value: "1901",
      sources: [{ title: "Assessment record", type: "archive", reference: "leaf 1" }],
      confidence: "confirmed" };
    await app.archive.write(assessed, (await app.archive.read()).revision);
    for (const method of ["POST", "PUT"] as const)
      await unchangedAfter("relative", method, (next) => {
        next.people[0].events![0].dateClaim!.confidence = "conflicting";
      }, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
