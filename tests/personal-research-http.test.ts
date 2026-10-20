import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { userStore } from "../src/server/users.ts";
import type { Person } from "../src/domain/types.ts";

test("personal saves and undo obey identities, current scope, origin, revision and repeat guards", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-personal-research-"));
  const oldOrigin = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://archive.test";
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const db = app.archive.db;
  const users = await userStore(db);
  const cookies = new Map<string, string>();
  const request = (
    path: string,
    id = "owner",
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookies.get(id) || "",
        Origin: "https://archive.test",
        ...(body !== undefined && body !== null
          ? { "Content-Type": "application/json" }
          : {}),
        ...extra,
      },
      ...(body !== undefined && body !== null
        ? { body: JSON.stringify(body) }
        : {}),
    });
  const person = (id: string, birth = "1980"): Person => ({
    id,
    name: id,
    surname: "Тестов",
    patronymic: "",
    sex: "u",
    birth,
    birthPlace: "",
    parents: [],
    spouses: [],
    sources: [],
    generation: 1,
    column: 0,
  });
  try {
    for (const [index, id] of ["owner", "reader", "other"].entries()) {
      await users.register(id, id);
      const token = String(index + 1).repeat(64);
      await db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        )
        .run(
          createHash("sha256").update(token).digest("hex"),
          id,
          Date.now() + 3600_000,
        );
      cookies.set(id, `drevo_session=${token}`);
    }
    await db.prepare("UPDATE users SET approved=1").run();
    const owner = (await users.get("owner"))!;
    const initial = await app.archive.read();
    await app.archive.write(
      {
        ...initial.family,
        people: [person("visible"), person("hidden", "1900")],
        photos: [],
      },
      initial.revision,
      owner,
    );
    const target = { kind: "person", id: "hidden", remove: false };
    assert.equal((await request("/api/bookmarks", "", target)).status, 401);
    assert.equal(
      (
        await request("/api/bookmarks", "reader", target, {
          Origin: "https://evil.test",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("/api/bookmarks", "reader", target)).status,
      200,
    );
    assert.equal(
      (await (await request("/api/bookmarks", "other")).json()).items.length,
      0,
    );
    assert.equal(
      (await (await request("/api/bookmarks", "reader")).json()).items.length,
      1,
    );
    const read = app.archive.read;
    app.archive.read = async () => {
      throw new Error("Bookmarked names must not hydrate the full archive");
    };
    try {
      assert.equal((await request("/api/bookmarks", "reader")).status, 200);
      assert.equal((await request("/api/bookmarks", "other")).status, 200);
    } finally {
      app.archive.read = read;
    }
    assert.equal(
      (await request("/api/bookmarks", "reader", target)).status,
      200,
      "idempotent bookmark add",
    );
    assert.equal(
      (await (await request("/api/bookmarks", "reader")).json()).items.length,
      1,
    );
    const criteria = { allOf: [{ birthYearFrom: 1950 }] };
    const documentId = "11111111-1111-4111-8111-111111111111";
    await db
      .prepare(
        "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        documentId,
        "Личный документ",
        "личный документ",
        "fixture.pdf",
        1,
        "owner",
        new Date().toISOString(),
      );
    await db
      .prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)")
      .run(documentId, "hidden");
    assert.equal(
      (
        await request("/api/bookmarks", "reader", {
          kind: "document",
          id: documentId,
          remove: false,
        })
      ).status,
      200,
    );
    const savedDoc = (
      await (await request("/api/bookmarks", "reader")).json()
    ).items.find((item: { kind: string }) => item.kind === "document");
    assert.equal(savedDoc.label, "Личный документ");
    assert.equal(savedDoc.href, `/documents/${documentId}`);
    assert.equal(
      (
        await request("/api/people-filters", "reader", {
          name: "Современные",
          criteria,
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await request("/api/people-filters", "other")).json()).items
        .length,
      0,
    );
    assert.equal(
      (
        await request("/api/people-filters", "reader", {
          name: "Вредный",
          criteria: { sql: "SELECT *" },
        })
      ).status,
      400,
    );
    await db
      .prepare(
        "UPDATE users SET tree_access='common_ancestors',person_id='visible' WHERE id='reader'",
      )
      .run();
    assert.equal(
      (await (await request("/api/bookmarks", "reader")).json()).items.length,
      0,
      "hidden names must not survive a narrowed grant",
    );
    assert.equal(
      (await request("/api/bookmarks", "reader", target)).status,
      404,
    );
    assert.equal(
      (await (await request("/api/bookmarks", "reader")).json()).unavailable,
      2,
    );
    assert.equal(
      (await request("/api/bookmarks", "reader", { clearUnavailable: true }))
        .status,
      200,
    );
    assert.equal(
      (await (await request("/api/bookmarks", "reader")).json()).unavailable,
      0,
    );
    const filtered = await request("/api/people/filter", "reader", {
      criteria: { allOf: [{ hasBirthDate: true }] },
    });
    assert.equal(filtered.status, 200);
    assert.deepEqual((await filtered.json()).personIds, ["visible"]);
    assert.equal(
      (
        await request(
          "/api/people/filter",
          "reader",
          { criteria },
          { Origin: "https://evil.test" },
        )
      ).status,
      403,
    );

    const before = await app.archive.read();
    const edited = structuredClone(before.family);
    edited.people[0].name = "Новое имя";
    const saved = await app.archive.write(edited, before.revision, owner);
    const route = `/api/audit/transactions/${saved.revision}`;
    assert.equal((await request(route + "/preview", "reader")).status, 403);
    const preview = await (await request(route + "/preview")).json();
    assert.equal(preview.canUndo, true);
    const another = structuredClone(saved.family);
    another.people[1].birthPlace = "Москва";
    await app.archive.write(another, saved.revision, owner);
    assert.equal(
      (
        await request(route + "/undo", "owner", null, {
          "If-Match": String(preview.currentRevision),
        })
      ).status,
      409,
    );
    const fresh = await (await request(route + "/preview")).json();
    assert.equal(fresh.canUndo, true, "independent edits remain undoable");
    const undone = await request(route + "/undo", "owner", null, {
      "If-Match": String(fresh.currentRevision),
    });
    assert.equal(undone.status, 200, await undone.text());
    const current = await app.archive.read();
    assert.equal(current.family.people[0].name, "visible");
    assert.equal(current.family.people[1].birthPlace, "Москва");
    assert.equal(
      (
        await request(route + "/undo", "owner", null, {
          "If-Match": String(current.revision),
        })
      ).status,
      409,
    );
    assert.equal(
      (await (await request(route + "/preview")).json()).canUndo,
      false,
    );
    assert.equal(
      (await db.prepare("SELECT count(*) AS n FROM audit_reverts").get())!.n,
      1,
    );
    const next = structuredClone(current.family);
    next.people[0].birth = "1981";
    const oldChange = await app.archive.write(next, current.revision, owner);
    next.people[0].birth = "1982";
    await app.archive.write(next, oldChange.revision, owner);
    assert.equal(
      (
        await (
          await request(`/api/audit/transactions/${oldChange.revision}/preview`)
        ).json()
      ).canUndo,
      false,
    );
    next.people[0].birth = "1981";
    await app.archive.write(next, (await app.archive.meta()).revision, owner);
    assert.equal(
      (
        await (
          await request(`/api/audit/transactions/${oldChange.revision}/preview`)
        ).json()
      ).canUndo,
      false,
      "an intervening same-field edit remains protected after its value is restored",
    );
    await db.prepare("DELETE FROM history").run();
    const unavailable = await (
      await request(`/api/audit/transactions/${oldChange.revision}/preview`)
    ).json();
    assert.equal(unavailable.canUndo, false);
    await db.prepare("UPDATE users SET approved=0 WHERE id='reader'").run();
    assert.equal((await request("/api/people-filters", "reader")).status, 401);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await app.archive.close();
    if (oldOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = oldOrigin;
    rmSync(directory, { recursive: true, force: true });
  }
});
