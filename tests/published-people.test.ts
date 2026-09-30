import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { startServer } from "../src/server/index.ts";

test("only explicitly published people are searchable without tree access, and unpublishing revokes the direct link", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-public-people-"));
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  const previousPrivate = process.env.ARCHIVE_PRIVATE;
  process.env.PUBLIC_ORIGIN = "http://localhost";
  process.env.ARCHIVE_PRIVATE = "1";
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer(0, join(directory, "archive.sqlite"), true);
    const person = {
      id: "published-person",
      surname: "Иванов",
      name: "Павел",
      patronymic: "Петрович",
      maidenName: "Сидоров",
      sex: "m",
      birth: "1908-01-01",
      death: "1980-01-01",
      birthPlace: "Тверь",
      deathPlace: "Москва",
      biography: "Private biography",
      parents: [],
      spouses: [],
      generation: 1,
      column: 0,
      sources: [],
    };
    const initial = await app.archive.read();
    await app.archive.write(
      {
        ...initial.family,
        people: [
          person,
          {
            ...person,
            id: "living-person",
            birth: "1988-01-01",
            death: undefined,
          },
        ],
      },
      initial.revision,
    );
    await app.archive.db
      .prepare(
        "INSERT INTO users(id,name,role,approved) VALUES('admin','Админ','admin',1),('reader','Читатель','reader',0)",
      )
      .run();
    async function cookie(id: string) {
      const token = randomBytes(32).toString("hex");
      await app!.archive.db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        )
        .run(
          createHash("sha256").update(token).digest("hex"),
          id,
          Date.now() + 60000,
        );
      return `drevo_session=${token}`;
    }
    const admin = await cookie("admin");
    const reader = await cookie("reader");
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const request = (path: string, session = reader, method = "GET", body?: unknown) =>
      fetch(base + path, {
        method,
        headers: { Cookie: session, Origin: "http://localhost", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const query =
      "/api/published-people/search?q=%D0%98%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2";
    assert.equal((await request("/api/family")).status, 401);
    assert.deepEqual((await (await request(query)).json()).results, []);
    assert.equal(
      (
        await request(
          "/api/admin/published-people/published-person",
          reader,
          "PUT",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/admin/published-people/published-person",
          admin,
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (await request("/api/admin/published-people/living-person", admin, "PUT"))
        .status,
      400,
    );
    const results = (await (await request(query)).json()).results;
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      id: person.id,
      name: "Иванов Павел Петрович",
      birthYear: "1908",
      deathYear: "1980",
      birthPlace: "Тверь",
      deathPlace: "Москва",
    });
    assert.doesNotMatch(
      JSON.stringify(results),
      /biography|Private|parents|sources/,
    );
    assert.equal(
      (await request("/api/published-people/published-person")).status,
      200,
    );
    const chosenFields = {
      birthSurname: true,
      birthYear: false,
      deathYear: true,
      birthPlace: false,
      deathPlace: false,
    };
    assert.equal((await request(
      "/api/admin/published-people/published-person", admin, "PUT", { fields: chosenFields },
    )).status, 200);
    assert.deepEqual((await (await request("/api/published-people/published-person")).json()).person, {
      id: person.id,
      name: "Иванов Павел Петрович",
      birthSurname: "Сидоров",
      deathYear: "1980",
    });
    assert.deepEqual((await (await request("/api/published-people/search?q=Тверь")).json()).results, []);
    assert.equal((await (await request("/api/published-people/search?q=Сидоров")).json()).results.length, 1);
    assert.equal((await request(
      "/api/admin/published-people/published-person", admin, "PUT", { fields: { birthYear: true } },
    )).status, 400);
    const beforeStatusChange = await app.archive.read();
    await app.archive.write(
      {
        ...beforeStatusChange.family,
        people: beforeStatusChange.family.people.map((entry) =>
          entry.id === person.id
            ? { ...entry, death: undefined, deceased: false }
            : entry,
        ),
      },
      beforeStatusChange.revision,
    );
    assert.deepEqual((await (await request(query)).json()).results, []);
    assert.equal(
      (await request("/api/published-people/published-person")).status,
      404,
    );
    const beforeRestore = await app.archive.read();
    await app.archive.write(
      {
        ...beforeRestore.family,
        people: beforeRestore.family.people.map((entry) =>
          entry.id === person.id
            ? { ...entry, death: person.death, deceased: true }
            : entry,
        ),
      },
      beforeRestore.revision,
    );
    assert.equal(
      (
        await request(
          "/api/admin/published-people/published-person",
          admin,
          "DELETE",
        )
      ).status,
      200,
    );
    assert.deepEqual((await (await request(query)).json()).results, []);
    assert.equal(
      (await request("/api/published-people/published-person")).status,
      404,
    );
    assert.equal((await request(query, "")).status, 401);
  } finally {
    if (app) await app.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
    if (previousPrivate === undefined) delete process.env.ARCHIVE_PRIVATE;
    else process.env.ARCHIVE_PRIVATE = previousPrivate;
    rmSync(directory, { recursive: true, force: true });
  }
});
