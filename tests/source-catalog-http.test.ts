import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { Family } from "../src/domain/types.ts";

test("one catalog source confirms multiple facts, stays current, and legacy citations survive", async () => {
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
    const created = await request("/api/sources", "POST", {
      title: "Метрическая книга", type: "архивная запись", author: "",
      institution: "", archive: "ГАСО", fond: "6", opis: "13", delo: "104",
      sheet: "12", reference: "", url: "", accessedAt: "2026-10-01",
      description: "Запись о рождении", documentIds: [],
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
    assert.equal((await app.archive.db.prepare("SELECT count(*) AS n FROM source_catalog").get())?.n, 1);
    assert.equal((await request(`/api/sources/${source.id}`, "DELETE", { version: 2 })).status, 409);
    const beforeUnlink = await app.archive.read();
    assert.equal((await request(`/api/sources/${source.id}/links`, "DELETE", {
      personId: "anna", eventId: "move", revision: beforeUnlink.revision,
    })).status, 200);
    assert.equal((await app.archive.read()).family.people[0].events?.[0].sources?.length, 0);
    const foreign = structuredClone((await app.archive.read()).family);
    foreign.people[0].sources.push({ catalogId: "foreign-source", title: "Чужой", type: "", reference: "" });
    await assert.rejects(app.archive.write(foreign, (await app.archive.read()).revision), /Источник отсутствует/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
