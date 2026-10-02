import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Family } from "../src/domain/types.ts";
import type { createAuth } from "../src/server/auth.ts";
import { openArchive } from "../src/server/database.ts";
import { faceDescriptorsHttp } from "../src/server/face-descriptors-http.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

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
      tags: [
        { id: "tag-first", personId: "first", x: 0, y: 0, width: 1, height: 1 },
      ],
    },
  ],
};

test("face matching stays server-side and saving still requires confirmation", async () => {
  const archive = await openArchive(":memory:", family);
  await archive.db
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
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
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

    await archive.db
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
      sourceTagId: "tag-first",
      model: "face-api-1.7.15",
    });
    assert.equal(response.status, 201);
    const count = (await archive.db
      .prepare("SELECT COUNT(*) AS count FROM face_descriptors")
      .get()) as { count: number };
    assert.equal(Number(count.count), 4);
    assert.equal(
      (await archive.db
        .prepare("SELECT source_tag_id FROM face_descriptors WHERE id=?")
        .get("confirmed"))!.source_tag_id,
      "source-photo:tag-first",
    );

    // Legacy 128-D templates do not consume the Human model's sample quota.
    const addLegacy = archive.db.prepare(
      "INSERT INTO face_descriptors(id,person_id,data) VALUES(?,?,?)",
    );
    for (let index = 0; index < 18; index++)
      await addLegacy.run(
        `legacy-${index}`,
        "first",
        JSON.stringify(Array(128).fill(0.01)),
      );
    response = await post("/api/faces/descriptors", {
      id: "human-confirmed",
      personId: "first",
      descriptor: Array(1024).fill(0.04),
      sourcePhotoId: "source-photo",
      sourceTagId: "tag-first",
      model: "human-faceres-3.3.6",
    });
    assert.equal(response.status, 201);

    await archive.db
      .prepare(
        "INSERT INTO face_descriptors(id,person_id,data,model) VALUES(?,?,?,?)",
      )
      .run(
        "human-second",
        "second",
        JSON.stringify(Array(1024).fill(0.62)),
        "human-faceres-3.3.6",
      );
    response = await post("/api/faces/match", {
      descriptor: Array(1024).fill(0.32),
      model: "human-faceres-3.3.6",
    });
    assert.deepEqual(await response.json(), { match: null });
    response = await post("/api/faces/match", {
      descriptor: Array(1024).fill(0.27),
      model: "human-faceres-3.3.6",
    });
    assert.equal((await response.json()).match.personId, "first");

    // The five successful matches above consume the same account budget.
    for (let index = 5; index < 120; index++) {
      response = await post("/api/faces/match", {
        descriptor: Array(128).fill(0.19),
      });
      assert.equal(response.status, 200);
    }
    response = await post("/api/faces/match", {
      descriptor: Array(128).fill(0.19),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");

    canEdit = false;
    response = await post("/api/faces/match", {
      descriptor: Array(128).fill(0),
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await archive.close();
  }
});

test("face descriptors follow corrected tags and disappear with removed tags", async () => {
  const archive = await openArchive(":memory:", family);
  try {
    await archive.db
      .prepare(
        `INSERT INTO face_descriptors
           (id,person_id,data,source_photo_id,source_tag_id,model)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(
        "remembered",
        "first",
        JSON.stringify(Array(1024).fill(0.04)),
        "source-photo",
        "source-photo:tag-first",
        "human-faceres-3.3.6",
      );

    let current = await archive.read();
    await archive.write(
      {
        ...current.family,
        photos: current.family.photos!.map((photo) => ({
          ...photo,
          tags: photo.tags.map((tag) =>
            tag.id === "tag-first" ? { ...tag, personId: "second" } : tag,
          ),
        })),
      },
      current.revision,
    );
    assert.equal(
      (await archive.db
        .prepare("SELECT person_id FROM face_descriptors WHERE id=?")
        .get("remembered"))!.person_id,
      "second",
    );

    current = await archive.read();
    await archive.write(
      {
        ...current.family,
        photos: current.family.photos!.map((photo) => ({
          ...photo,
          tags: photo.tags.filter((tag) => tag.id !== "tag-first"),
        })),
      },
      current.revision,
    );
    assert.equal(
      (await archive.db
        .prepare("SELECT count(*) AS n FROM face_descriptors WHERE id=?")
        .get("remembered"))!.n,
      0,
    );
  } finally {
    await archive.close();
  }
});

test("face match is withheld when archive access changes during comparison", async () => {
  const archive = await openArchive(":memory:", family);
  const originalPrepare = archive.db.prepare.bind(archive.db);
  let actor: ArchiveUser = {
    id: "editor", name: "Editor", role: "admin", approved: true,
    createdAt: "", treeAccess: "all",
  };
  let changeAfterRead: "none" | "revoke" | "scope" = "none";
  archive.db.prepare = (sqlite, postgres) => {
    const statement = originalPrepare(sqlite, postgres);
    if (!sqlite.includes("SELECT person_id,data FROM face_descriptors WHERE model=?"))
      return statement;
    return {
      ...statement,
      all: async (...values) => {
        const rows = await statement.all(...values);
        if (changeAfterRead === "revoke") actor = { ...actor, approved: false };
        if (changeAfterRead === "scope") actor = {
          ...actor, role: "relative", treeAccess: "common_ancestors", personId: "second",
        };
        return rows;
      },
    };
  };
  await archive.db.prepare(
    "INSERT INTO face_descriptors(id,person_id,data) VALUES(?,?,?)",
  ).run("known", "first", JSON.stringify(Array(128).fill(0)));
  const auth = {
    local: true,
    canEdit: () => actor.approved,
    currentUser: () => actor,
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const handler = faceDescriptorsHttp({ archive, auth });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://localhost"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const url = `http://127.0.0.1:${address.port}/api/faces/match`;
    const body = JSON.stringify({ descriptor: Array(128).fill(0) });
    const request = () => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal((await request()).status, 200);
    changeAfterRead = "revoke";
    const denied = await request();
    assert.equal(denied.status, 403);
    assert.doesNotMatch(await denied.text(), /"personId":"first"/);
    actor = { ...actor, approved: true, role: "admin", treeAccess: "all" };
    changeAfterRead = "scope";
    const scoped = await request();
    assert.equal(scoped.status, 403);
    assert.doesNotMatch(await scoped.text(), /"personId":"first"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    archive.db.prepare = originalPrepare;
    await archive.close();
  }
});
