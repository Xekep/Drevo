import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Family } from "../src/domain/types.ts";
import type { createAuth } from "../src/server/auth.ts";
import { openArchive } from "../src/server/database.ts";
import { faceDescriptorsHttp } from "../src/server/face-descriptors-http.ts";

const person = (id: string) => ({
  id,
  name: id,
  surname: "Тестов",
  patronymic: "",
  sex: "u" as const,
  birth: "",
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
});

const family: Family = {
  title: "Отпечатки лиц",
  description: "",
  demo: false,
  people: [person("first"), person("second")],
  photos: [
    {
      id: "source-photo",
      url: "/media/source-photo.jpg",
      title: "",
      createdBy: "editor",
      tags: [{ id: "tag-first", personId: "first", x: 0, y: 0, width: 1, height: 1 }],
    },
  ],
};

test("face matching stays server-side and saving still requires confirmation", async () => {
  const archive = openArchive(":memory:", family);
  archive.db
    .prepare(
      "INSERT INTO face_descriptors(id,person_id,data) VALUES(?,?,?),(?,?,?)",
    )
    .run(
      "known-first",
      "first",
      JSON.stringify(Array(128).fill(0)),
      "known-second",
      "second",
      JSON.stringify(Array(128).fill(0.2)),
    );
  let canEdit = true;
  const auth = {
    canEdit: () => canEdit,
    currentUser: () =>
      canEdit ? { id: "editor", role: "admin", approved: true } : null,
  } as unknown as ReturnType<typeof createAuth>;
  const handler = faceDescriptorsHttp({ archive, auth });
  const server = createServer(async (req, res) => {
    if (await handler(req, res, new URL(req.url || "/", "http://localhost")))
      return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, headers?: HeadersInit) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    const bulk = await fetch(base + "/api/faces/descriptors");
    assert.equal(bulk.status, 405);
    assert.doesNotMatch(await bulk.text(), /known-first|descriptor/);

    let response = await post("/api/faces/match", {
      descriptor: Array(128).fill(0.19),
    });
    assert.equal(response.status, 200);
    const nearest = await response.json();
    assert.equal(nearest.match.personId, "second");
    assert.ok(nearest.match.distance < 0.12);
    assert.deepEqual(Object.keys(nearest.match).sort(), [
      "distance",
      "personId",
    ]);

    response = await post("/api/faces/match", {
      descriptor: Array(128).fill(1),
    });
    assert.deepEqual(await response.json(), { match: null });

    archive.db
      .prepare(
        "INSERT INTO face_descriptors(id,person_id,data,model) VALUES(?,?,?,?)",
      )
      .run(
        "human-first",
        "first",
        JSON.stringify(Array(1024).fill(0.04)),
        "human-faceres-3.3.6",
      );
    response = await post("/api/faces/match", {
      descriptor: Array(1024).fill(0.04),
      model: "human-faceres-3.3.6",
    });
    assert.deepEqual(await response.json(), {
      match: { personId: "first", distance: 0 },
    });

    response = await post(
      "/api/faces/match",
      { descriptor: Array(128).fill(0.19) },
      { "Sec-Fetch-Site": "cross-site" },
    );
    assert.equal(response.status, 403);

    response = await post("/api/faces/descriptors", {
      id: "confirmed",
      personId: "first",
      descriptor: Array(128).fill(0.01),
      sourcePhotoId: "source-photo",
      model: "face-api-1.7.15",
    });
    assert.equal(response.status, 201);
    const count = archive.db
      .prepare("SELECT COUNT(*) AS count FROM face_descriptors")
      .get() as { count: number };
    assert.equal(Number(count.count), 4);

    canEdit = false;
    response = await post("/api/faces/match", {
      descriptor: Array(128).fill(0),
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    archive.close();
  }
});
