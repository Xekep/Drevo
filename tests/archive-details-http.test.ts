import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openArchive } from "../src/server/database.ts";
import { archiveQueryHttp } from "../src/server/archive-query-http.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { settingsStore } from "../src/server/settings.ts";
import type { treePreferencesStore } from "../src/server/tree-preferences.ts";
import type { researchCatalogStore } from "../src/server/research-catalog.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string, parents: string[] = []): Person => ({
  id,
  name: id,
  surname: "Тест",
  patronymic: "",
  sex: "u",
  birth: "1900",
  birthPlace: "",
  generation: 1,
  column: 0,
  parents,
  spouses: [],
  biography: `Биография ${id}`,
  sources: [{ type: "archive", title: `Источник ${id}`, reference: "" }],
});
const seed: Family = {
  title: "Тест",
  description: "",
  demo: false,
  people: [person("parent"), person("child", ["parent"]), person("hidden")],
  photos: [
    {
      id: "shared",
      url: "/media/shared.jpg",
      title: "Снимок",
      tags: ["child", "hidden"].map((personId, i) => ({
        id: `tag${i}`,
        personId,
        x: i / 2,
        y: 0,
        width: 0.5,
        height: 1,
      })),
    },
    {
      id: "own-unrelated",
      createdBy: "reader",
      url: "/media/own.jpg",
      title: "Личный снимок",
      tags: [],
    },
  ],
};
test("demand detail HTTP reads indexed IDs and tagged photos within the current access projection", async (t) => {
  const store = await openArchive(":memory:", seed);
  let actor: ArchiveUser | null = {
    id: "reader",
    name: "Тест",
    role: "reader",
    approved: true,
    personId: "child",
    treeAccess: "common_ancestors",
    createdAt: "2026-01-01",
  };
  let access = { publicTree: false, publicAlbums: false };
  let afterRead: (() => void) | undefined;
  const originalPage = store.peoplePage;
  store.peoplePage = async (...args) => {
    const data = await originalPage(...args);
    const action = afterRead;
    afterRead = undefined;
    action?.();
    return data;
  };
  store.read = async () => {
    throw new Error("Full archive hydration is forbidden for a card read");
  };
  const handler = archiveQueryHttp({
    archive: store,
    auth: {
      local: true,
      currentUser: async () => actor,
      canEdit: async () => false,
      isPlatformAdmin: async () => false,
    } as unknown as Awaited<ReturnType<typeof createAuth>>,
    visibility: { read: async () => access } as Awaited<
      ReturnType<typeof settingsStore>
    >,
    treePreferences: { read: async () => null } as unknown as ReturnType<
      typeof treePreferencesStore
    >,
    researchCatalog: {} as ReturnType<typeof researchCatalogStore>,
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://local.test")).catch(
      (error) => {
        res.writeHead(500);
        res.end(String(error));
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/family`;
  const token = "1:1:1:reader:child:common_ancestors";
  const query = (ids: string[], pageToken = token, offset = 0) =>
    base +
    "?" +
    new URLSearchParams({
      projection: "details",
      ids: JSON.stringify(ids),
      token: pageToken,
      offset: String(offset),
    });
  const response = await fetch(query(["child"]));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const data = await response.json();
  assert.deepEqual(
    data.people.map((p: Person) => p.id),
    ["child"],
  );
  assert.equal(data.people[0].biography, "Биография child");
  assert.equal(data.people[0].sources[0].title, "Источник child");
  assert.equal(data.photoTotal, 1);
  assert.deepEqual(
    data.photos.map((p: { id: string }) => p.id),
    ["shared"],
  );
  assert.deepEqual(
    data.photos[0].tags.map((tag: { personId: string }) => tag.personId),
    ["child"],
  );
  for (const ids of [["hidden"], ["child", "hidden"], ["missing"]]) {
    const denied = await fetch(query(ids));
    assert.equal(denied.status, 404);
    assert.doesNotMatch(await denied.text(), /Биография|Источник|shared\.jpg/);
  }
  for (const ids of [
    [],
    ["child", "child"],
    [".."],
    Array.from({ length: 41 }, (_, i) => `id${i}`),
  ])
    assert.equal((await fetch(query(ids))).status, 400);
  assert.equal((await fetch(query(["child"], "old"))).status, 409);
  assert.equal((await fetch(query(["child"], token, -1))).status, 400);
  const member = actor;
  afterRead = () => {
    actor = { ...member!, approved: false };
  };
  const changed = await fetch(query(["child"]));
  assert.equal(changed.status, 409);
  assert.doesNotMatch(await changed.text(), /Биография|Источник|shared\.jpg/);
  actor = null;
  access = { publicTree: true, publicAlbums: false };
  const guest = await fetch(query(["child"], "1:1:0:guest::all"));
  assert.equal(guest.status, 200);
  assert.deepEqual((await guest.json()).photos, []);
  access = { publicTree: false, publicAlbums: true };
  assert.equal((await fetch(query(["child"], "1:0:1:guest::all"))).status, 401);
});
