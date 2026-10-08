import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { Family, Source } from "../src/domain/types.ts";

test("a document remains attached while any exact claim, union citation, or catalog source uses it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-document-citations-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const documentId = "22222222-2222-4222-8222-222222222222";
  const citation: Source = { title: "Метрическая книга", type: "archive", reference: "л. 12",
    documentId, documentPage: 2 };
  const person = (id: string) => ({ id, name: id, surname: "Тестов", patronymic: "", sex: "u" as const,
    birth: "1880", death: "1950", birthPlace: "Реж", deathPlace: "Екатеринбург",
    parents: [], spouses: [], sources: [], generation: 1, column: 0 });
  const family: Family = { title: "Цитаты", description: "", demo: false,
    people: [person("anna"), person("boris")],
    unions: [{ id: "marriage", participants: ["anna", "boris"], type: "marriage" }] };
  const request = (method: string, path: string, body?: unknown) => fetch(base + path, {
    method, ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
  });
  try {
    await app.archive.write(family, (await app.archive.read()).revision);
    await app.archive.db.prepare(
      "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,document_date,place,description,provenance,annotations,event_links,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(documentId, "Скан", "скан", "scan.pdf", 100, "local", "2026-10-01T00:00:00Z",
      "", "", "", "", "", "[]", "[]", "[]");
    await app.archive.db.prepare(
      "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
    ).run(documentId, "anna");

    const slots: Array<[string, (next: Family) => void]> = [
      ["birth date", (next) => { next.people[0].birthDateClaim = { value: "1880", sources: [citation] }; }],
      ["death date", (next) => { next.people[0].deathDateClaim = { value: "1950", sources: [citation] }; }],
      ["birth place", (next) => { next.people[0].birthPlaceClaim = { value: "Реж", sources: [citation] }; }],
      ["death place", (next) => { next.people[0].deathPlaceClaim = { value: "Екатеринбург", sources: [citation] }; }],
      ["award", (next) => { next.people[0].awards = [{ id: "medal", name: "Медаль",
        sources: [citation] }]; }],
      ["union", (next) => { next.unions![0].sources = [citation]; }],
      ["formation", (next) => { next.unions![0].formation = { date: "1900", sources: [citation] }; }],
      ["ending", (next) => { next.unions![0].ending = { date: "1940", sources: [citation] }; }],
      ["divorce", (next) => { next.unions![0].divorce = { date: "1940", sources: [citation] }; }],
      ["ongoing", (next) => { next.unions![0].ongoing = { date: "1930", sources: [citation] }; }],
      ["additional link", (next) => { next.links = [{ id: "care", from: "anna", to: "boris",
        type: "presumed_parent", sources: [citation] }]; }],
    ];
    for (const [slot, attach] of slots) {
      const snapshot = await app.archive.read();
      const next = structuredClone(family);
      attach(next);
      await app.archive.write(next, snapshot.revision);
      assert.equal((await request("DELETE", `/api/documents/${documentId}`)).status, 409, slot);
      assert.equal((await request("PATCH", `/api/documents/${documentId}`, {
        people: { expected: ["anna"], next: [] },
      })).status, 409, slot);
      assert.equal((await app.archive.db.prepare("SELECT count(*) AS n FROM document_people WHERE document_id=?")
        .get(documentId))?.n, 1, slot);
    }
    await app.archive.write(family, (await app.archive.read()).revision);
    const created = await request("POST", "/api/sources", {
      title: "Метрическая книга", documentIds: [documentId],
    });
    assert.equal(created.status, 201, await created.clone().text());
    const source = (await created.json()) as { source: { id: string; version: number } };
    assert.equal((await request("DELETE", `/api/documents/${documentId}`)).status, 409,
      "a catalog attachment protects the document even without a citation");
    assert.equal((await app.archive.db.prepare("SELECT count(*) AS n FROM documents WHERE id=?")
      .get(documentId))?.n, 1);
    assert.equal((await request("PUT", `/api/sources/${source.source.id}`, {
      version: source.source.version, documentIds: [],
    })).status, 200);
    assert.equal((await request("PATCH", `/api/documents/${documentId}`, {
      people: { expected: ["anna"], next: [] },
    })).status, 200, "removing a person association is allowed after citations are removed");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
