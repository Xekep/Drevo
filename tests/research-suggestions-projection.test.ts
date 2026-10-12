import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openArchive } from "../src/server/database.ts";
import { researchSuggestionStore } from "../src/server/research-suggestions.ts";
import { researchSuggestionsHttp } from "../src/server/research-suggestions-http.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Person } from "../src/domain/types.ts";

test("pending suggestions resolve only referenced visible names without hydrating biographies or albums", async t => {
  const person = (id: string, parents: string[] = []): Person => ({ id, name: id, surname: "Фамилия", patronymic: "Отчество", sex: "u", birth: "1900", birthPlace: "", generation: 1, column: 0, parents, spouses: [], sources: [], biography: "PRIVATE BIOGRAPHY".repeat(1000) });
  const archive = await openArchive(":memory:", { title: "Test", description: "", demo: false, people: [person("parent"), person("child", ["parent"]), person("hidden")], photos: [] });
  const actor: ArchiveUser = { id: "relative", name: "User", role: "relative", approved: true, personId: "child", treeAccess: "common_ancestors", createdAt: "2026-10-12" };
  const suggestions = researchSuggestionStore(archive.db);
  for (const id of ["child", "hidden"]) await archive.db.prepare("INSERT INTO research_suggestions(id,kind,status,person_id,payload,reason,evidence,base_revision,created_at,created_by) VALUES(?,'person_update','pending',?,?,'Reason','[]',1,'2026-10-12','relative')").run(`suggestion-${id}`, id, JSON.stringify({ changes: { birth: "1994" }, before: { birth: "1900" } }));
  archive.read = async () => { throw new Error("full archive read forbidden"); };
  const handler = researchSuggestionsHttp({ archive, suggestions, auth: { local: true, currentUser: async () => actor, canEdit: async () => true } as unknown as Awaited<ReturnType<typeof createAuth>> });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "https://example.test")).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await archive.close(); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/research/suggestions`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.suggestions.map((item: { id: string }) => item.id), ["suggestion-child"]);
  assert.equal(body.suggestions[0].personName, "Фамилия child Отчество");
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE BIOGRAPHY|suggestion-hidden/);
});
