import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { openPromise } from "yauzl";
import { openArchive } from "../src/server/database.ts";
import { startServer } from "../src/server/index.ts";
import {
  validateFamily,
  type Family,
  type Person,
} from "../src/domain/index.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";

const person = (id: string, parents: string[] = []): Person => ({
  id,
  name: id,
  surname: "Тестов",
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  parents,
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
});
const family: Family = {
  title: "Проверка доступа",
  description: "",
  demo: false,
  people: [
    person("ancestor"),
    person("me", ["ancestor"]),
    person("sibling", ["ancestor"]),
    person("niece", ["sibling"]),
    { ...person("hidden"), photo: "/media/secret.png" },
  ],
  links: [{ id: "god", type: "godparent", from: "hidden", to: "me" }],
  photos: [],
};

test("область общих предков не раскрывает другие ветви и сохраняет собственные новые карточки", () => {
  const user = {
    id: "relative",
    name: "Участник",
    role: "relative" as const,
    approved: true,
    createdAt: "",
    personId: "me",
    treeAccess: "common_ancestors" as const,
  };
  const projected = projectFamilyForUser(family, user);
  assert.deepEqual(
    projected.people.map((p) => p.id),
    ["ancestor", "me", "sibling", "niece"],
  );
  assert.deepEqual(projected.links, []);
  validateFamily(projected);
  const withOwn = {
    ...family,
    people: [...family.people, { ...person("new-branch"), createdBy: user.id }],
  };
  assert.ok(
    projectFamilyForUser(withOwn, user).people.some(
      (p) => p.id === "new-branch",
    ),
  );
});

test("привязка аккаунта и область видимости действуют во всех основных HTTP-маршрутах", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-tree-access-"));
  const path = join(dir, "drevo.sqlite");
  const original = Object.fromEntries(
    [
      "PUBLIC_ORIGIN",
      "YANDEX_CLIENT_ID",
      "YANDEX_CLIENT_SECRET",
      "ARCHIVE_PRIVATE",
    ].map((key) => [key, process.env[key]]),
  );
  process.env.PUBLIC_ORIGIN = "https://drevo.kiiko.ru";
  process.env.YANDEX_CLIENT_ID = "test-client";
  process.env.YANDEX_CLIENT_SECRET = "test-secret";
  process.env.ARCHIVE_PRIVATE = "1";
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await (await openArchive(path, family)).close();
    mkdirSync(join(dir, "uploads"));
    writeFileSync(
      join(dir, "uploads", "secret.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const provider: typeof fetch = async (url, options) =>
      String(url).includes("/token")
        ? Response.json({
            access_token: (options!.body as URLSearchParams).get("code"),
          })
        : Response.json({
            id: (
              options!.headers as Record<string, string>
            ).Authorization.slice(6),
            display_name: "Участник",
          });
    app = await startServer(0, path, true, provider);
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const request = (
      route: string,
      cookie = "",
      method = "GET",
      body?: unknown,
      revision?: number,
    ) =>
      fetch(base + route, {
        method,
        headers: {
          Cookie: cookie,
          Origin: "https://drevo.kiiko.ru",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(revision === undefined ? {} : { "If-Match": String(revision) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const login = async (id: string) => {
      const start = await fetch(base + "/auth/yandex", { redirect: "manual" });
      const state = new URL(start.headers.get("location")!).searchParams.get(
        "state",
      );
      const response = await fetch(
        base + `/auth/yandex/callback?state=${state}&code=${id}`,
        {
          headers: { Cookie: start.headers.getSetCookie()[0].split(";")[0] },
          redirect: "manual",
        },
      );
      assert.equal(response.status, 303);
      return response.headers
        .getSetCookie()
        .find((item) => item.startsWith("drevo_session="))!
        .split(";")[0];
    };
    const admin = await login("admin"),
      relative = await login("relative"),
      reader = await login("reader");
    assert.equal(
      (await request("/api/users/reader", admin, "PATCH", { role: "reader" }))
        .status,
      200,
    );
    assert.equal(
      (
        await request("/api/users/relative", admin, "PATCH", {
          role: "relative",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/users/relative", admin, "PATCH", {
          personId: "me",
          treeAccess: "common_ancestors",
        })
      ).status,
      200,
    );
    const session = await request("/api/session", relative).then((res) =>
      res.json(),
    );
    assert.equal(session.user.personId, "me");
    assert.equal(session.user.treeAccess, "common_ancestors");
    assert.equal(
      (
        await request("/api/users/relative", admin, "PATCH", {
          personId: "missing",
          treeAccess: "common_ancestors",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/api/users/admin", admin, "PATCH", {
          personId: "me",
          treeAccess: "all",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/api/settings", admin, "PUT", {
          publicTree: true,
          publicAlbums: false,
          reverseTimeline: false,
        })
      ).status,
      400,
    );
    const overview = await request(
      "/api/family?projection=overview",
      relative,
    ).then((res) => res.json());
    assert.deepEqual(
      overview.family.people.map((p: Person) => p.id),
      ["ancestor", "me", "sibling", "niece"],
    );
    assert.equal(overview.totals.people, 4);
    const page = await request(
      `/api/family?projection=page&collection=people&offset=0&token=${encodeURIComponent(overview.pageToken)}`,
      relative,
    ).then((res) => res.json());
    assert.deepEqual(
      page.items.map((p: Person) => p.id),
      ["ancestor", "me", "sibling", "niece"],
    );
    const complete = await request("/api/family", relative).then((res) =>
      res.json(),
    );
    assert.equal(complete.family.people.length, 4);
    assert.deepEqual(complete.family.links, []);
    assert.equal(
      (
        await request(
          "/api/offline/export?scope=family&anchor=hidden",
          relative,
        )
      ).status,
      404,
    );
    const offline = await request("/api/offline/export?scope=all", relative);
    assert.equal(offline.status, 200);
    const offlinePath = join(dir, "scoped-offline.zip");
    writeFileSync(offlinePath, Buffer.from(await offline.arrayBuffer()));
    const zip = await openPromise(offlinePath);
    let exportedFamily: Family | undefined;
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== "family.json") continue;
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry))
        chunks.push(Buffer.from(chunk));
      exportedFamily = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    assert.deepEqual(
      exportedFamily?.people.map((p) => p.id),
      ["ancestor", "me", "sibling", "niece"],
    );
    assert.ok(!JSON.stringify(exportedFamily).includes("hidden"));
    assert.equal(
      (
        await request("/api/people/search?q=hidden", relative).then((res) =>
          res.json(),
        )
      ).people.length,
      0,
    );
    assert.equal(
      (await request("/api/export.json", relative).then((res) => res.json()))
        .people.length,
      4,
    );
    assert.equal((await request("/media/secret.png", relative)).status, 401);
    assert.equal((await request("/media/secret.png", admin)).status, 200);
    assert.equal((await request("/media/secret.png", reader)).status, 200);
    await app.archive.db
      .prepare(
        "INSERT INTO face_descriptors(id,person_id,data,model) VALUES(?,?,?,?)",
      )
      .run(
        "hidden-face",
        "hidden",
        JSON.stringify(Array(128).fill(0.1)),
        "face-api-1.7.15",
      );
    const face = { descriptor: Array(128).fill(0.1) };
    assert.deepEqual(
      (
        await request("/api/faces/match", relative, "POST", face).then((res) =>
          res.json(),
        )
      ).match,
      null,
    );
    assert.equal(
      (
        await request("/api/faces/match", admin, "POST", face).then((res) =>
          res.json(),
        )
      ).match.personId,
      "hidden",
    );
    assert.equal(
      (
        await request(
          "/api/family",
          relative,
          "PUT",
          complete.family,
          complete.revision,
        )
      ).status,
      403,
    );

    const fresh = person("new-branch");
    const saved = await request(
      "/api/family/changes",
      relative,
      "POST",
      { changes: [{ collection: "people", id: fresh.id, after: fresh }] },
      complete.revision,
    );
    assert.equal(saved.status, 200);
    const own = await saved.json();
    assert.deepEqual(
      own.family.people.map((p: Person) => p.id),
      ["ancestor", "me", "sibling", "niece", "new-branch"],
    );
    assert.equal(own.family.people.at(-1).createdBy, "relative");
    for (const change of [
      {
        collection: "people",
        id: "new-branch",
        field: "photo",
        after: "/media/secret.png",
      },
      {
        collection: "photos",
        id: "copied-secret",
        after: {
          id: "copied-secret",
          title: "Copy",
          url: "/media/secret.png",
          tags: [],
        },
      },
    ]) {
      const denied = await request(
        "/api/family/changes",
        relative,
        "POST",
        { changes: [change] },
        own.revision,
      );
      assert.equal(
        denied.status,
        403,
        "assigning a known hidden URL must not grant access",
      );
      assert.equal((await app.archive.meta()).revision, own.revision);
    }
    assert.equal((await request("/media/secret.png", relative)).status, 401);
    assert.equal(
      (
        await request(
          "/api/family/changes",
          relative,
          "POST",
          {
            changes: [
              {
                collection: "people",
                id: "new-branch",
                field: "parents",
                before: [],
                after: ["hidden"],
              },
            ],
          },
          own.revision,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/family/changes",
          relative,
          "POST",
          {
            changes: [
              {
                collection: "people",
                id: "hidden",
                field: "name",
                before: "hidden",
                after: "Подмена",
              },
            ],
          },
          own.revision,
        )
      ).status,
      403,
    );
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const upload = await fetch(base + "/api/portraits", {
      method: "POST",
      headers: {
        Cookie: relative,
        Origin: "https://drevo.kiiko.ru",
        "Content-Type": "image/png",
        "X-Drevo-Upload": "1",
        "If-Match": String(own.revision),
      },
      body: new Uint8Array(png).buffer,
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    writeFileSync(join(dir, "uploads", "orphan.png"), png);
    assert.equal(
      (await request(uploaded.url, relative)).status,
      200,
      "own pending portrait is readable before assignment",
    );
    for (const route of [
      uploaded.url,
      `${uploaded.url}?variant=thumb`,
      `${uploaded.url}?variant=tiny`,
      "/media/orphan.png",
    ])
      assert.equal(
        (await request(route, reader)).status,
        401,
        "a full-archive reader cannot read another user's pending or orphaned media",
      );
    assert.equal((await request(uploaded.url)).status, 401);
    const attached = await request(
      "/api/family/changes",
      relative,
      "POST",
      {
        changes: [
          {
            collection: "people",
            id: "new-branch",
            field: "photo",
            after: uploaded.url,
          },
        ],
      },
      own.revision,
    );
    assert.equal(attached.status, 200);
    await app.archive.db.prepare("DELETE FROM media_upload_grants").run();
    assert.equal((await request(uploaded.url, reader)).status, 200);
    assert.equal(
      (await request(uploaded.url, relative)).status,
      200,
      "assigned portrait uses regular scope checks",
    );
    assert.equal(
      (
        await request("/api/users/relative", admin, "PATCH", {
          treeAccess: "all",
        })
      ).status,
      200,
    );
    assert.equal(
      (await request("/api/family", relative).then((res) => res.json())).family
        .people.length,
      6,
    );
    assert.equal(
      (
        await request("/api/settings", admin, "PUT", {
          publicTree: true,
          publicAlbums: false,
          reverseTimeline: false,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/users/relative", admin, "PATCH", {
          treeAccess: "common_ancestors",
        })
      ).status,
      400,
    );
    const beforeRemoval = await app.archive.read();
    await app.archive.write(
      {
        ...beforeRemoval.family,
        people: beforeRemoval.family.people.map((person) =>
          person.id === "new-branch" ? { ...person, photo: undefined } : person,
        ),
      },
      beforeRemoval.revision,
    );
    assert.equal((await request(uploaded.url, reader)).status, 401);
  } finally {
    await app?.close();
    for (const [key, value] of Object.entries(original))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});
