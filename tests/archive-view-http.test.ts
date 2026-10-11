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
  birthPlace: "Пермь",
  parents,
  spouses: [],
  generation: 1,
  column: 1,
  sources: [{ title: "Длинный источник", type: "archive", reference: "1" }],
  biography: "secret-biography",
});
const seed: Family = {
  title: "Тест",
  description: "",
  demo: false,
  people: [person("parent"), person("child", ["parent"]), person("hidden")],
  photos: Array.from({ length: 72 }, (_, i) => ({
    id: `photo-${i}`,
    url: `/media/${i}.jpg`,
    title: `Снимок ${i}`,
    year: "1900",
    tags: (i < 63 ? ["child", "hidden"] : ["hidden"]).map((id) => ({
      id,
      personId: id,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })),
  })),
};
test("compact views and gallery pages enforce scope, public album privacy, token and delivery revision", async (t) => {
  const archive = await openArchive(":memory:", seed);
  let actor: ArchiveUser | null = {
    id: "reader",
    name: "Reader",
    role: "reader",
    approved: true,
    createdAt: "2026-01-01",
    personId: "child",
    treeAccess: "common_ancestors",
  };
  let access = { publicTree: false, publicAlbums: false },
    changeAtDelivery: (() => Promise<void>) | undefined;
  const handler = archiveQueryHttp({
    archive,
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
    beforeDelivery: async () => {
      const action = changeAtDelivery;
      changeAtDelivery = undefined;
      await action?.();
    },
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
    await archive.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/family`;
  const overview = () =>
    fetch(base + "?projection=overview").then((response) => response.json());
  const read = (
    projection: string,
    token: string,
    params: Record<string, string> = {},
  ) =>
    fetch(base + "?" + new URLSearchParams({ projection, token, ...params }));
  const token = (await overview()).pageToken;
  const first = await read("gallery", token, { mode: "all" });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const page = await first.json();
  assert.equal(page.photos.length, 30);
  assert.equal(page.total, 63);
  assert.equal(page.photoIds.length, 63);
  assert.ok(
    page.photos.every((photo: { tags: { personId: string }[] }) =>
      photo.tags.every((tag) => tag.personId === "child"),
    ),
  );
  const second = await (
    await read("gallery", token, { mode: "all", offset: "30" })
  ).json();
  assert.equal(second.photos.length, 30);
  assert.equal(
    new Set([...page.photos, ...second.photos].map((photo) => photo.id)).size,
    60,
  );
  const map = await (await read("places", token)).json();
  assert.deepEqual(
    map.people.map((p: { id: string }) => p.id),
    ["parent", "child"],
  );
  assert.ok(
    map.photos.every((photo: { tags: { personId: string }[] }) =>
      photo.tags.every((tag) => tag.personId === "child"),
    ),
  );
  assert.doesNotMatch(JSON.stringify(map), /secret-biography|Длинный источник/);
  assert.equal(
    (await (await read("insights", token)).json()).insights.totals.people,
    2,
  );
  assert.equal((await read("gallery", "wrong", { mode: "all" })).status, 409);
  assert.equal((await read("gallery", token, { mode: "invalid" })).status, 400);
  assert.equal((await read("gallery", token, { offset: "-1" })).status, 400);
  actor = null;
  access = { publicTree: false, publicAlbums: true };
  const publicToken = (await overview()).pageToken;
  const publicPage = await (
    await read("gallery", publicToken, { mode: "all" })
  ).json();
  assert.equal(publicPage.total, 72);
  assert.ok(
    publicPage.photos.every((photo: { tags: unknown[] }) => !photo.tags.length),
  );
  assert.equal(
    (await (await read("insights", publicToken)).json()).insights.totals.people,
    0,
  );
  // Revocation between preparation and delivery is checked after preparation on PG;
  // its transactional race is covered by postgres-archive-query-delivery.ts.
  changeAtDelivery = async () => {
    access = { publicTree: false, publicAlbums: false };
  };
  await read("places", publicToken);
  assert.equal((await read("gallery", publicToken)).status, 401);
});
