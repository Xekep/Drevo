import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openArchive } from "../src/server/database.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { settingsStore } from "../src/server/settings.ts";
import {
  currentGeocodingStore,
  geocodingStore,
  type GeocodingStore,
} from "../src/server/geocoding.ts";
import { placesHttp } from "../src/server/places-http.ts";
import type { Family } from "../src/domain/types.ts";

const family: Family = {
  title: "Места",
  description: "",
  demo: false,
  people: [
    {
      id: "person",
      surname: "Тестов",
      name: "Иван",
      patronymic: "",
      sex: "m",
      birth: "1950",
      birthPlace: "Москва",
      parents: [],
      spouses: [],
      sources: [],
      generation: 1,
      column: 0,
    },
  ],
};

test("places HTTP searches only visible family places and rechecks access after locate", async () => {
  const archive = openArchive(":memory:", family);
  let publicTree = true,
    calls = 0,
    revokeOnLocate = false;
  const auth = {
      currentUser: () => null,
      canEdit: () => false,
    } as unknown as ReturnType<typeof createAuth>,
    visibility = {
      read: () => ({
        publicTree,
        publicAlbums: false,
        reverseTimeline: false,
      }),
    } as unknown as ReturnType<typeof settingsStore>,
    geocoding: GeocodingStore = {
      async locate(query) {
        calls++;
        if (revokeOnLocate) publicTree = false;
        return { query, candidates: [] };
      },
      close() {},
    },
    handler = placesHttp({
      archive,
      auth,
      visibility,
      geocoding: () => geocoding,
    }),
    server = createServer(async (req, res) => {
      if (await handler(req, res, new URL(req.url || "/", "http://localhost")))
        return;
      res.writeHead(404).end();
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    let response = await fetch(
      base + "/api/places/locate?q=" + encodeURIComponent("Москва"),
      { headers: { "X-Drevo-Map": "1" } },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).query, "Москва");
    assert.equal(calls, 1);

    response = await fetch(
      base + "/api/places/locate?q=" + encodeURIComponent("Неизвестно"),
      { headers: { "X-Drevo-Map": "1" } },
    );
    assert.equal(response.status, 403);
    assert.equal(calls, 1, "скрытое место не уходит во внешний geocoder");

    publicTree = true;
    revokeOnLocate = true;
    response = await fetch(
      base + "/api/places/locate?q=" + encodeURIComponent("Москва"),
      { headers: { "X-Drevo-Map": "1" } },
    );
    assert.equal(response.status, 403);
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    archive.close();
  }
});

test("geocoding registry exposes the active store and clears it on close", () => {
  const db = new DatabaseSync(":memory:"),
    store = geocodingStore(db, async () => Response.json({ features: [] }), 0);
  try {
    assert.equal(currentGeocodingStore(db), store);
    store.close();
    assert.throws(() => currentGeocodingStore(db));
  } finally {
    db.close();
  }
});
