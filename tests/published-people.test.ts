import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { startServer } from "../src/server/index.ts";
import { defaultPublicationFields } from "../src/shared/publication.ts";

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
          { ...person, id: "second-person", surname: "Петров", name: "Анна" },
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
    const batch = "/api/admin/published-people/batch";
    const previewPath = `${batch}/preview`;
    const preview = async (personIds: string[], action: "publish" | "unpublish") =>
      await request(previewPath, admin, "POST", { personIds, action, fields: chosenFields });
    assert.equal((await request(previewPath, reader, "POST", {
      personIds: [person.id], action: "publish", fields: chosenFields,
    })).status, 403, "only an archive admin can inspect a private batch");
    assert.equal((await request(batch, admin, "POST", {
      personIds: [person.id, "second-person"], fields: chosenFields,
    })).status, 400, "a batch cannot publish without a server review");
    assert.equal((await preview([person.id, "living-person"], "publish")).status, 409);
    assert.equal((await request("/api/published-people/living-person")).status, 404);
    const staleReview = await (await preview([person.id, "second-person"], "publish")).json();
    assert.equal(staleReview.people.length, 2);
    assert.equal(staleReview.people[1].published, false);
    assert.deepEqual(Object.keys(staleReview.people[1].person).sort(),
      ["id", "name", "birthSurname", "deathYear"].sort(),
      "the server review shows exactly the scalar fields it would publish");
    assert.doesNotMatch(JSON.stringify(staleReview), /Private biography|biography|parents|sources/);
    const beforeBatchEdit = await app.archive.read();
    await app.archive.write({ ...beforeBatchEdit.family, people: beforeBatchEdit.family.people.map((entry) =>
      entry.id === "second-person" ? { ...entry, birthPlace: "Новое место" } : entry),
    }, beforeBatchEdit.revision);
    assert.equal((await request(batch, admin, "POST", {
      personIds: [person.id, "second-person"], fields: chosenFields,
      revision: staleReview.revision, reviewToken: staleReview.reviewToken,
    })).status, 409, "an archive revision change invalidates the whole batch");
    assert.equal((await request("/api/published-people/second-person")).status, 404);
    const publishReview = await (await preview([person.id, "second-person"], "publish")).json();
    assert.equal((await request(batch, admin, "POST", {
      personIds: [person.id], fields: chosenFields,
      revision: publishReview.revision, reviewToken: publishReview.reviewToken,
    })).status, 409, "confirmation is bound to the complete reviewed list");
    assert.equal((await request(batch, admin, "POST", {
      personIds: [person.id, "second-person"], fields: defaultPublicationFields,
      revision: publishReview.revision, reviewToken: publishReview.reviewToken,
    })).status, 409, "confirmation is bound to the exact reviewed field choice");
    assert.equal((await request(batch, admin, "POST", {
      personIds: [person.id, "second-person"], fields: chosenFields,
      revision: publishReview.revision, reviewToken: publishReview.reviewToken,
    })).status, 200);
    const statuses = await (await request(`${batch}?id=${person.id}&id=second-person`, admin)).json();
    assert.deepEqual(statuses.fields[person.id], chosenFields);
    assert.deepEqual(statuses.fields["second-person"], chosenFields);
    assert.equal((await request("/api/published-people/second-person")).status, 200);
    const revokeReview = await (await preview(["second-person"], "unpublish")).json();
    assert.equal((await request("/api/admin/published-people/second-person", admin, "PUT")).status, 200);
    assert.equal((await request(batch, admin, "DELETE", {
      personIds: ["second-person"], revision: revokeReview.revision,
      reviewToken: revokeReview.reviewToken,
    })).status, 409, "a changed publication invalidates a stale revocation review");
    const freshRevoke = await (await preview(["second-person"], "unpublish")).json();
    assert.equal((await request(batch, admin, "DELETE", {
      personIds: ["second-person"], revision: freshRevoke.revision,
      reviewToken: freshRevoke.reviewToken,
    })).status, 200);
    assert.equal((await request("/api/published-people/second-person")).status, 404);
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
    assert.equal(
      (await (await request("/api/admin/published-people/published-person", admin)).json()).published,
      false,
      "changing an explicitly published card to living revokes the owner's publication consent",
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
    assert.deepEqual((await (await request(query)).json()).results, [],
      "marking the card deceased again must not silently restore discovery");
    assert.equal((await request("/api/published-people/published-person")).status, 404);
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
