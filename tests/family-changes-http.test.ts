import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveChanges, validateFamily } from "../src/domain/index.ts";
import { startServer } from "../src/server/index.ts";

test("family change endpoint saves a small delta and rejects stale or unsafe changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-family-changes-"));
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  delete process.env.PUBLIC_ORIGIN;
  const app = await startServer(0, join(dir, "drevo.sqlite"), true),
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const initialResponse = await fetch(base + "/api/family");
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json(),
      before = validateFamily(initial.family),
      next = structuredClone(before);
    assert.ok(next.people.length > 0);
    next.people[0].name = `${next.people[0].name} изменён`;
    const changes = archiveChanges(before, next),
      deltaBody = JSON.stringify({ changes });
    assert.ok(changes.length > 0);
    assert.ok(deltaBody.length < JSON.stringify(next).length);

    const savedResponse = await fetch(base + "/api/family/changes", {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "If-Match": String(initial.revision),
      },
      body: deltaBody,
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.revision, initial.revision + 1);
    assert.equal(saved.family.people[0].name, next.people[0].name);

    const stale = await fetch(base + "/api/family/changes", {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "If-Match": String(initial.revision),
      },
      body: deltaBody,
    });
    assert.equal(stale.status, 409);

    const wrongBefore = await fetch(base + "/api/family/changes", {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "If-Match": String(saved.revision),
      },
      body: JSON.stringify({
        changes: [
          {
            collection: "people",
            id: saved.family.people[0].id,
            field: "name",
            before: "Не текущее имя",
            after: "Не должно сохраниться",
          },
        ],
      }),
    });
    assert.equal(wrongBefore.status, 409);

    const unsafe = await fetch(base + "/api/family/changes", {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "If-Match": String(saved.revision),
      },
      body: JSON.stringify({
        changes: [
          {
            collection: "people",
            id: saved.family.people[0].id,
            field: "__proto__",
            before: null,
            after: { polluted: true },
          },
        ],
      }),
    });
    assert.equal(unsafe.status, 400);

    const crossSite = await fetch(base + "/api/family/changes", {
      method: "POST",
      headers: {
        Origin: "https://example.invalid",
        "Content-Type": "application/json",
        "If-Match": String(saved.revision),
      },
      body: JSON.stringify({ changes: [] }),
    });
    assert.equal(crossSite.status, 403);

    const finalResponse = await fetch(base + "/api/family");
    const final = await finalResponse.json();
    assert.equal(final.revision, saved.revision);
    assert.equal(final.family.people[0].name, next.people[0].name);
  } finally {
    await app.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
    rmSync(dir, { recursive: true, force: true });
  }
});
