import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { Family } from "../src/domain/types.ts";

test("one catalog source confirms multiple facts, stays current, and legacy citations survive", async () => {
  const documentId = "22222222-2222-4222-8222-222222222222";
  const dir = await mkdtemp(join(tmpdir(), "drevo-source-catalog-"));
  const app = await startServer(0, join(dir, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (path: string, method: string, value: unknown) => fetch(base + path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
  });
  const family: Family = {
    title: "Источники", description: "", demo: false,
    people: [{ id: "anna", name: "Анна", surname: "Тестова", patronymic: "",
      sex: "f", birth: "1880", birthPlace: "", parents: [], spouses: [],
      generation: 1, column: 0,
      sources: [{ title: "Старая запись", type: "архив", reference: "л. 3" }],
      events: [{ id: "move", type: "move", sources: [] }] }],
  };
  try {
    const original = await app.archive.read();
    await app.archive.write(family, original.revision);
    assert.equal((await request("/api/sources", "POST", {
      title: "Чужой документ", documentIds: ["11111111-1111-4111-8111-111111111111"],
    })).status, 400);
    assert.equal((await request("/api/sources", "POST", {
      title: "Неверная дата", accessedAt: "2026-99-99",
    })).status, 400);
    await app.archive.db.prepare(
      "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,document_date,place,description,provenance,annotations,event_links,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(documentId, "Скан", "скан", "scan.pdf", 100, "local", "2026-10-01T00:00:00Z",
      "", "", "", "", "", "[]", "[]", "[]");
    const created = await request("/api/sources", "POST", {
      title: "Метрическая книга", type: "архивная запись", author: "",
      institution: "", archive: "ГАСО", fond: "6", opis: "13", delo: "104",
      sheet: "12", reference: "", url: "", accessedAt: "2026-10-01",
      description: "Запись о рождении", documentIds: [documentId],
    });
    assert.equal(created.status, 201);
    const source = (await created.json() as { source: { id: string; version: number } }).source;
    const first = await app.archive.read();
    assert.equal((await request(`/api/sources/${source.id}/links`, "POST", {
      personId: "anna", revision: first.revision,
    })).status, 200);
    const second = await app.archive.read();
    assert.equal((await request(`/api/sources/${source.id}/links`, "POST", {
      personId: "anna", eventId: "move", revision: second.revision,
      documentId, documentPage: 12,
    })).status, 200);
    assert.equal((await request(`/api/sources/${source.id}/links`, "POST", {
      personId: "anna", revision: second.revision,
    })).status, 409);
    const updated = await request(`/api/sources/${source.id}`, "PUT", {
      version: 1, title: "Исправленная книга",
    });
    assert.equal(updated.status, 200);
    assert.equal((await request(`/api/sources/${source.id}`, "PUT", {
      version: 1, title: "Устаревшая правка",
    })).status, 409);
    const person = (await app.archive.read()).family.people[0];
    assert.equal(person.sources[0].title, "Старая запись");
    assert.equal(person.sources[1].title, "Исправленная книга");
    assert.equal(person.events?.[0].sources?.[0].title, "Исправленная книга");
    assert.equal((await app.archive.peoplePage(0, 10))[0].sources[1].title,
      "Исправленная книга");
    assert.equal(person.events?.[0].sources?.[0].documentPage, 12);
    assert.equal((await request(`/api/sources/${source.id}`, "PUT", {
      version: 2, documentIds: [],
    })).status, 409);
    const afterRejectedEdit = await app.archive.read();
    await app.archive.write(afterRejectedEdit.family, afterRejectedEdit.revision);
    assert.equal((await app.archive.read()).family.people[0].events?.[0].sources?.[0].documentId, documentId);
    assert.equal((await app.archive.read()).family.people[0].events?.[0].sources?.[0].documentPage, 12);
    assert.equal((await app.archive.db.prepare("SELECT count(*) AS n FROM source_catalog").get())?.n, 1);
    assert.equal((await request(`/api/sources/${source.id}`, "DELETE", { version: 2 })).status, 409);
    const beforeUnlink = await app.archive.read();
    assert.equal((await request(`/api/sources/${source.id}/links`, "DELETE", {
      personId: "anna", eventId: "move", revision: beforeUnlink.revision,
    })).status, 200);
    assert.equal((await app.archive.read()).family.people[0].events?.[0].sources?.length, 0);
    const wrongDocument = structuredClone((await app.archive.read()).family);
    wrongDocument.people[0].sources.push({
      catalogId: source.id, title: "Метрическая книга", type: "архив", reference: "",
      documentId: "33333333-3333-4333-8333-333333333333", documentPage: 8,
    });
    await assert.rejects(app.archive.write(wrongDocument, (await app.archive.read()).revision),
      /Документ цитаты отсутствует/);
    const foreign = structuredClone((await app.archive.read()).family);
    foreign.people[0].sources.push({ catalogId: "foreign-source", title: "Чужой", type: "", reference: "" });
    await assert.rejects(app.archive.write(foreign, (await app.archive.read()).revision), /Источник отсутствует/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("source catalog search is server-paginated and rejects invalid bounds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-source-page-"));
  const app = await startServer(0, join(dir, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    for (let index = 0; index < 23; index++) {
      const response = await fetch(base + "/api/sources", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: index === 0 ? "Метрическая книга" : `Запись ${index}`,
          archive: index === 0 ? "ГАСО" : "", fond: index === 0 ? "6" : "",
          opis: index === 0 ? "13" : "", delo: index === 0 ? "104" : "",
          sheet: index === 0 ? "12" : "" }),
      });
      assert.equal(response.status, 201);
    }
    const first = await fetch(base + "/api/sources?limit=10&offset=0").then((r) => r.json());
    const second = await fetch(base + "/api/sources?limit=10&offset=10").then((r) => r.json());
    assert.equal(first.total, 23);
    assert.equal(first.sources.length, 10);
    assert.equal(second.sources.length, 10);
    assert.equal(new Set([...first.sources, ...second.sources].map((source) => source.id)).size, 20);
    const matched = await fetch(base + "/api/sources?q=метрическая&limit=5").then((r) => r.json());
    assert.equal(matched.total, 1);
    assert.equal(matched.sources[0].title, "Метрическая книга");
    const archiveMatch = await fetch(base + "/api/sources?q=гасо&limit=5").then((r) => r.json());
    assert.equal(archiveMatch.total, 1);
    assert.equal(archiveMatch.sources[0].archive, "ГАСО");
    const cipherMatch = await fetch(base + "/api/sources?q=104&limit=5").then((r) => r.json());
    assert.equal(cipherMatch.total, 1);
    assert.equal(cipherMatch.sources[0].delo, "104");
    assert.equal((await fetch(base + "/api/sources?limit=101")).status, 400);
    assert.equal((await fetch(base + "/api/sources?offset=-1")).status, 400);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
