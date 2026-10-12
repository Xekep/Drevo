import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openArchive } from "../src/server/database.ts";
import { auditStore } from "../src/server/audit.ts";
import { adminSharingHttp } from "../src/server/admin-sharing-http.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { sharesStore } from "../src/server/shares.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

test("journal authors include former members, use their latest recorded name and page without duplicates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-audit-authors-"));
  const archive = await openArchive(join(directory, "archive.sqlite"), {
    title: "Проверка журнала",
    description: "",
    demo: false,
    people: [],
  });
  try {
    const audit = auditStore(archive.db);
    const entry = {
      action: "Изменено",
      entity: "person" as const,
      entityId: "p",
      label: "Карточка",
      personIds: [],
      details: [],
    };
    for (let i = 0; i < 35; i++)
      await audit.record(entry, { id: `former-${i}`, name: `Автор ${i}` });
    await audit.record(entry, { id: "former-0", name: "Новое имя автора" });
    await audit.record(entry);
    const first = await audit.actors();
    assert.equal(first.actors.length, 30);
    assert.deepEqual(first.actors[0], {
      id: "former-0",
      name: "Новое имя автора",
    });
    assert.ok(first.next);
    const second = await audit.actors(first.next);
    assert.equal(second.actors.length, 5);
    assert.equal(second.next, null);
    assert.equal(
      new Set([...first.actors, ...second.actors].map((actor) => actor.id))
        .size,
      35,
    );
    assert.equal(
      first.actors.some((actor) => actor.id === "system"),
      false,
    );
  } finally {
    await archive.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("author directory denies readers and rechecks revoked owner access before delivery", async () => {
  let reads = 0;
  const owner = {
    id: "owner",
    name: "Владелец",
    role: "admin" as const,
    archiveOwner: true,
    approved: true,
    createdAt: "",
  };
  let current = {
    ...owner,
    role: "reader" as "admin" | "reader",
    archiveOwner: false,
  };
  const auth = { currentUser: async () => current } as unknown as Awaited<
    ReturnType<typeof createAuth>
  >;
  const audit = {
    actors: async () => {
      reads++;
      current = { ...current, archiveOwner: false, role: "reader" };
      return { actors: [{ id: "hidden", name: "Не выдавать" }], next: null };
    },
  } as unknown as ReturnType<typeof auditStore>;
  const handler = adminSharingHttp({
    archive: {} as Awaited<ReturnType<typeof openArchive>>,
    auth,
    audit,
    shares: {} as ReturnType<typeof sharesStore>,
  });
  let status = 0,
    body = "";
  const response = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (value: string) => {
      body = value;
    },
  } as unknown as ServerResponse;
  const request = { method: "GET" } as IncomingMessage;
  await handler(
    request,
    response,
    new URL("http://localhost/api/audit/actors"),
  );
  assert.equal(status, 403);
  assert.equal(reads, 0);
  current = owner;
  await handler(
    request,
    response,
    new URL("http://localhost/api/audit/actors"),
  );
  assert.equal(status, 403);
  assert.equal(reads, 1);
  assert.doesNotMatch(body, /Не выдавать/);
});
