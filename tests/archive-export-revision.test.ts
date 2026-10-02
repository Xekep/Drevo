import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { Family } from "../src/domain/types.ts";
import { archiveQueryHttp } from "../src/server/archive-query-http.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { openArchive } from "../src/server/database.ts";
import type { researchCatalogStore } from "../src/server/research-catalog.ts";
import type { settingsStore } from "../src/server/settings.ts";
import type { StoreDatabase } from "../src/server/store-database.ts";
import type { treePreferencesStore } from "../src/server/tree-preferences.ts";

test("unscoped JSON exports withhold a snapshot superseded before delivery", async () => {
  let revision = 1;
  let family: Family = {
    title: "Archive",
    description: "",
    demo: false,
    people: [
      {
        id: "person",
        name: "Old Secret",
        surname: "",
        patronymic: "",
        sex: "m",
        birth: "",
        birthPlace: "",
        parents: [],
        spouses: [],
        sources: [],
        generation: 1,
        column: 0,
      },
    ],
    photos: [
      { id: "photo", title: "Private", url: "/media/old.png", tags: [] },
    ],
  };
  let paused: { reached: () => void; resume: Promise<void> } | undefined;
  const db = {
    kind: "sqlite",
    prepare: () => ({ get: async () => ({ revision }) }),
    transaction: async <T>(work: () => Promise<T>) => await work(),
  } as unknown as StoreDatabase;
  const archive = {
    db,
    read: async () => {
      const snapshot = { revision, family: structuredClone(family) };
      const gate = paused;
      paused = undefined;
      if (gate) {
        gate.reached();
        await gate.resume;
      }
      return snapshot;
    },
  } as Awaited<ReturnType<typeof openArchive>>;
  const actor = { id: "admin", name: "Admin", role: "admin", approved: true };
  const auth = {
    local: false,
    currentUser: async () => actor,
    canEdit: async () => true,
    isPlatformAdmin: async () => false,
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const handler = archiveQueryHttp({
    archive,
    auth,
    visibility: {
      read: async () => ({ publicTree: false, publicAlbums: false }),
    } as Awaited<ReturnType<typeof settingsStore>>,
    treePreferences: { read: async () => null } as unknown as ReturnType<
      typeof treePreferencesStore
    >,
    researchCatalog: { list: async () => [] } as unknown as ReturnType<
      typeof researchCatalogStore
    >,
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://localhost")).catch(
      (error) => {
        res.destroy(error);
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const path of ["/api/export.json", "/api/export"]) {
      let reached!: () => void;
      let resume!: () => void;
      const readReached = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const readGate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      paused = { reached, resume: readGate };
      const pending = fetch(base + path);
      try {
        await readReached;
        revision++;
        family = {
          ...family,
          people: family.people.map((person) => ({
            ...person,
            name: `New-${revision}`,
          })),
          photos: [
            {
              id: "photo",
              title: "Private",
              url: `/media/new-${revision}.png`,
              tags: [],
            },
          ],
        };
      } finally {
        resume();
      }
      const response = await pending;
      assert.equal(response.status, 409, path);
      assert.doesNotMatch(
        await response.text(),
        /Old Secret|\/media\/old\.png/,
      );
      const fresh = await fetch(base + path);
      assert.equal(fresh.status, 200);
      assert.match(
        await fresh.text(),
        path === "/api/export"
          ? new RegExp(`/media/new-${revision}\\.png`)
          : new RegExp(`New-${revision}`),
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
