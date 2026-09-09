import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "../src/server/index.ts";
import { userStore } from "../src/server/users.ts";
import {
  familyGroups,
  validateFamily,
  type Family,
} from "../src/domain/index.ts";

test("first Yandex account becomes admin once; roles persist and last admin is protected", () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-users-")),
    path = join(dir, "users.sqlite");
  let db = new DatabaseSync(path);
  try {
    let store = userStore(db);
    const a = store.register("a", "Первый"),
      b = store.register("b", "Второй");
    assert.equal(a.role, "admin");
    assert.equal(b.role, "reader");
    assert.throws(() => store.setRole(a, a.id, "reader"));
    assert.throws(() => store.setRole(b, b.id, "admin"));
    store.setRole(a, b.id, "admin");
    store.setRole(a, a.id, "relative");
    assert.equal(store.register(a.id, "Новое имя").role, "relative");
    db.close();
    db = new DatabaseSync(path);
    store = userStore(db);
    assert.equal(store.register("c", "Третий").role, "reader");
    assert.equal(store.get(b.id)!.role, "admin");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth roles, ownership, public sections and complete backup work through HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-access-"));
  process.env.PUBLIC_ORIGIN = "https://drevo.kiiko.ru";
  process.env.YANDEX_CLIENT_ID = "test-client";
  process.env.YANDEX_CLIENT_SECRET = "test-secret";
  process.env.ARCHIVE_PRIVATE = "1";
  const provider: typeof fetch = async (url, options) =>
    String(url).includes("/token")
      ? Response.json({
          access_token: (options!.body as URLSearchParams).get("code"),
        })
      : Response.json({
          id: (options!.headers as Record<string, string>).Authorization.slice(
            6,
          ),
          display_name: "Участник",
        });
  const app = await startServer(0, join(dir, "drevo.sqlite"), true, provider),
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (
    path: string,
    cookie = "",
    method = "GET",
    body?: unknown,
    revision?: number,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: "https://drevo.kiiko.ru",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(revision !== undefined ? { "If-Match": String(revision) } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  async function login(id: string) {
    const start = await fetch(base + "/auth/yandex", { redirect: "manual" }),
      state = new URL(start.headers.get("location")!).searchParams.get("state");
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
      .find((c) => c.startsWith("drevo_session="))!
      .split(";")[0];
  }
  try {
    assert.equal((await request("/api/login", "", "POST", {})).status, 404);
    assert.equal((await request("/api/family")).status, 401);
    assert.equal((await request("/api/places/locate?q=unknown")).status, 401);
    const admin = await login("first"),
      reader = await login("second");
    assert.equal(
      (await request("/api/session", admin).then((r) => r.json())).user.role,
      "admin",
    );
    assert.equal(
      (await request("/api/session", reader).then((r) => r.json())).user.role,
      "reader",
    );
    assert.equal((await request("/api/users", reader)).status, 403);
    assert.equal(
      (
        await fetch(base + "/api/places/locate?q=unknown", {
          headers: { Cookie: reader, "X-Drevo-Map": "1" },
        })
      ).status,
      403,
    );
    assert.equal((await request("/api/backup", reader)).status, 403);
    assert.equal(
      (await request("/api/restore/preview", reader, "POST", {})).status,
      403,
    );
    assert.equal(
      (await request("/api/restore/apply", reader, "POST", {})).status,
      403,
    );
    let data = await request("/api/family", reader).then((r) => r.json());
    assert.equal(data.family.people.length, 0, "новый архив пустой");
    data.family.people.push({
      id: "admin-person",
      name: "Реальный",
      surname: "Человек",
      patronymic: "",
      sex: "m",
      birth: "1950",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      column: 0,
      generation: 1,
    });
    const created = await request(
      "/api/family",
      admin,
      "PUT",
      data.family,
      data.revision,
    );
    assert.equal(created.status, 200);
    data = await created.json();
    assert.equal(
      (await request("/api/family", reader, "PUT", data.family, data.revision))
        .status,
      403,
    );
    assert.equal(
      (await request("/api/users/second", admin, "PATCH", { role: "relative" }))
        .status,
      200,
    );
    assert.equal(
      (await request("/api/session", reader).then((r) => r.json())).canEdit,
      true,
    );
    data.family.people.push({
      ...data.family.people[0],
      id: "own",
      createdBy: undefined,
      birth: "",
      sex: "u",
      name: "Новая",
      parents: [],
      spouses: [],
      sources: [],
    });
    assert.equal(
      (await request("/api/restore/apply", reader, "POST", {})).status,
      403,
    );
    let response = await request(
      "/api/family",
      reader,
      "PUT",
      data.family,
      data.revision,
    );
    assert.equal(response.status, 200);
    data = await response.json();
    assert.equal(
      data.family.people.find((p: { id: string }) => p.id === "own").createdBy,
      "second",
    );
    const minimal = (
      await request("/api/family", reader).then((r) => r.json())
    ).family.people.find((p: { id: string }) => p.id === "own");
    assert.equal(minimal.birth, "");
    assert.equal(minimal.sex, "u");
    const original = structuredClone(data.family) as Family;
    const bad = structuredClone(original);
    bad.people[0].name = "Подмена";
    assert.equal(
      (await request("/api/family", reader, "PUT", bad, data.revision)).status,
      403,
    );
    const forged = structuredClone(original);
    forged.people[0].createdBy = "second";
    assert.equal(
      (await request("/api/family", reader, "PUT", forged, data.revision))
        .status,
      403,
    );
    const stolen = structuredClone(original);
    stolen.people.find((p) => p.id === "own")!.spouses = [stolen.people[0].id];
    assert.equal(
      (await request("/api/family", reader, "PUT", stolen, data.revision))
        .status,
      403,
    );
    const deletion = structuredClone(original);
    deletion.people = deletion.people.filter((p) => p.id !== "own");
    assert.equal(
      (await request("/api/family", reader, "PUT", deletion, data.revision))
        .status,
      403,
    );
    const own = structuredClone(original);
    own.people.find((p) => p.id === "own")!.name = "Своя правка";
    response = await request("/api/family", reader, "PUT", own, data.revision);
    assert.equal(response.status, 200);
    data = await response.json();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=",
      "base64",
    );
    response = await fetch(base + "/api/photos", {
      method: "POST",
      headers: {
        Cookie: reader,
        "If-Match": String(data.revision),
        "X-Drevo-Upload": "1",
        "X-Photo-Metadata": encodeURIComponent(
          JSON.stringify({
            title: "Семья на даче",
            place: "Москва",
            year: "1965",
            event: "Встреча",
          }),
        ),
      },
      body: png,
    });
    assert.equal(response.status, 201);
    data = await response.json();
    const photo = data.family.photos.at(-1);
    assert.equal(photo.createdBy, "second");
    assert.equal(photo.title, "Семья на даче");
    assert.equal(photo.year, "1965");
    assert.equal(photo.place, "Москва");
    assert.equal(photo.event, "Встреча");
    photo.tags = [
      { id: "t", personId: "own", x: 0.1, y: 0.1, width: 0.4, height: 0.5 },
    ];
    response = await request(
      "/api/family",
      reader,
      "PUT",
      data.family,
      data.revision,
    );
    assert.equal(response.status, 200);
    assert.equal(
      (
        await request("/api/settings", reader, "PUT", {
          publicTree: true,
          publicAlbums: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/api/settings", admin, "PUT", {
          publicTree: true,
          publicAlbums: false,
          reverseTimeline: true,
        })
      ).status,
      200,
    );
    let publicData = await request("/api/family").then((r) => r.json());
    assert.equal(publicData.reverseTimeline, true);
    assert.ok(publicData.family.people.length);
    assert.equal(publicData.family.photos.length, 0);
    assert.equal((await request(photo.url)).status, 401);
    await request("/api/settings", admin, "PUT", {
      publicTree: false,
      publicAlbums: true,
    });
    publicData = await request("/api/family").then((r) => r.json());
    assert.equal(
      publicData.reverseTimeline,
      true,
      "старый формат обновления видимости не сбрасывает направление времени",
    );
    assert.equal(publicData.family.people.length, 0);
    assert.equal(publicData.family.photos[0].tags.length, 0);
    assert.equal((await request(photo.url)).status, 200);
    validateFamily(publicData.family);
    assert.equal((await request("/api/backup/full", reader)).status, 403);
    response = await request("/api/backup/full", admin);
    assert.equal(response.status, 200);
    const full = join(dir, "full.tar.gz");
    writeFileSync(full, Buffer.from(await response.arrayBuffer()));
    const listing = execFileSync("tar", ["-tzf", full], { encoding: "utf8" });
    assert.match(listing, /drevo.sqlite/);
    assert.ok(listing.includes(photo.url.replace("/media/", "uploads/")));
    response = await request("/api/backup", admin);
    assert.equal(response.status, 200);
    const backup = join(dir, "backup.sqlite");
    writeFileSync(backup, Buffer.from(await response.arrayBuffer()));
    const db = new DatabaseSync(backup);
    assert.equal(
      db.prepare("PRAGMA integrity_check").get()!.integrity_check,
      "ok",
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM users").get()!.n, 2);
    db.close();
    await request("/api/users/second", admin, "PATCH", { role: "reader" });
    assert.equal(
      (await request("/api/session", reader).then((r) => r.json())).canEdit,
      false,
    );
    await request("/auth/logout", admin, "POST");
    assert.equal((await request("/api/backup", admin)).status, 401);
  } finally {
    await app.close();
    for (const key of [
      "PUBLIC_ORIGIN",
      "YANDEX_CLIENT_ID",
      "YANDEX_CLIENT_SECRET",
      "ARCHIVE_PRIVATE",
    ])
      delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("family catalog groups known parents and children without inventing a second parent", () => {
  const p = (id: string, parents: string[] = [], spouses: string[] = []) =>
    ({
      id,
      name: id,
      surname: id,
      birth: "1900",
      parents,
      spouses,
    }) as Family["people"][number];
  const groups = familyGroups([
    p("a", [], ["b"]),
    p("b", [], ["a"]),
    p("c", ["a", "b"]),
    p("d", ["a"]),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.find((g) => g.parents.length === 2)!.children.map((p) => p.id),
    ["c"],
  );
  assert.deepEqual(
    groups.find((g) => g.parents.length === 1)!.children.map((p) => p.id),
    ["d"],
  );
});
