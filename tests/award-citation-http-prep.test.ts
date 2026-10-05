import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server/index.ts";
import { archiveChanges } from "../src/domain/changes.ts";

test("award edits through real HTTP changes use the guarded full writer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-award-prep-http-"));
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  delete process.env.PUBLIC_ORIGIN;
  const app = await startServer(0, join(directory, "drevo.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const empty = await app.archive.read();
    await app.archive.write({ title: "Награды", description: "", demo: false,
      people: [{ id: "hero", name: "Иван", surname: "Примеров", patronymic: "",
        sex: "m", birth: "", birthPlace: "", parents: [], spouses: [],
        generation: 1, column: 0, sources: [] }] }, empty.revision);
    const first = await app.archive.read();
    const person = first.family.people[0];
    assert.ok(person);
    const seeded = structuredClone(person);
    seeded.awards = [{ id: "award-prep", name: "Медаль", sources: [{
      title: "Наградной лист", type: "архив", reference: "л. 2",
    }] }];
    await app.archive.db.transaction(async () => {
      await app.archive.db.prepare("UPDATE people SET data=? WHERE id=?")
        .run(JSON.stringify({ ...seeded, parents: undefined, spouses: undefined }),
          seeded.id);
      await app.archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1")
        .run();
    });
    const stored = await app.archive.read();
    const request = (method: "PUT" | "POST", revision: number, body: unknown) =>
      fetch(base + (method === "PUT" ? "/api/family" : "/api/family/changes"), {
        method,
        headers: { Origin: base, "Content-Type": "application/json",
          "If-Match": String(revision) },
        body: JSON.stringify(body),
      });
    const oldClient = structuredClone(stored.family);
    delete oldClient.people[0].awards![0].sources;
    oldClient.people[0].surname = "Уточнён";
    const unchanged = await request("PUT", stored.revision, oldClient);
    assert.equal(unchanged.status, 200, await unchanged.text());
    const saved = await app.archive.read();
    assert.equal(saved.family.people[0].awards?.[0].sources?.[0].reference, "л. 2");
    const edited = structuredClone(saved.family);
    edited.people[0].awards![0].sources![0].catalogId = "foreign-catalog";
    const denied = await request("POST", saved.revision,
      { changes: archiveChanges(saved.family, edited) });
    assert.equal(denied.status, 409, await denied.text());
    const remove = structuredClone(saved.family);
    remove.people[0].awards = [];
    const deniedRemoval = await request("POST", saved.revision,
      { changes: archiveChanges(saved.family, remove) });
    assert.equal(deniedRemoval.status, 409, await deniedRemoval.text());
    assert.equal((await app.archive.read()).revision, saved.revision);
    assert.equal((await app.archive.read()).family.people[0].awards?.[0]
      .sources?.[0].reference, "л. 2");
  } finally {
    await app.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
    rmSync(directory, { recursive: true, force: true });
  }
});
