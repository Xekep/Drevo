import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openArchive } from "../src/server/database.ts";
import { archiveQueryHttp } from "../src/server/archive-query-http.ts";
import { sharedTreeLayoutCache } from "../src/server/tree-layout-cache.ts";
import {
  LAYOUT_CACHE_VERSION,
  layoutCacheKey,
} from "../src/domain/layout-cache-key.ts";
import { projectTree } from "../src/domain/family-neighborhood.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family } from "../src/domain/types.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";

test("layout reuse checks current projection, membership, revision and origin for every participant", async (t) => {
  const seed: Family = {
    title: "Test",
    description: "",
    demo: false,
    people: ["parent", "child", "hidden"].map((id) => ({
      id,
      name: id,
      surname: "Test",
      patronymic: "",
      sex: "u",
      birth: "",
      birthPlace: "",
      parents: id === "child" ? ["parent"] : [],
      spouses: [],
      generation: 1,
      column: 0,
      sources: [],
    })),
    photos: [],
  };
  const archive = await openArchive(":memory:", seed);
  const root = await mkdtemp(join(tmpdir(), "drevo-layout-http-"));
  let calls = 0;
  const cache = sharedTreeLayoutCache(root, {
    calculate: async (input) => {
      calls++;
      return {
        mode: input.mode,
        reverse: input.reverse,
        start: 1700,
        offset: 0,
        positions: input.people.map((p, i) => [p.id, { x: 300 * i, y: 0 }]),
      } satisfies TreeGeometry;
    },
  });
  const member: ArchiveUser = {
    id: "first",
    name: "Reader",
    role: "reader",
    approved: true,
    createdAt: "2026-01-01",
  };
  let actor: ArchiveUser | null = member,
    beforeDelivery: (() => void) | undefined;
  type Options = Parameters<typeof archiveQueryHttp>[0];
  const handler = archiveQueryHttp({
    archive,
    treeLayouts: cache,
    auth: {
      local: true,
      currentUser: async () => actor,
      canEdit: async () => false,
    } as unknown as Options["auth"],
    visibility: {
      read: async () => ({ publicTree: true, publicAlbums: true }),
    } as Options["visibility"],
    treePreferences: {
      read: async () => null,
    } as unknown as Options["treePreferences"],
    researchCatalog: {} as Options["researchCatalog"],
    beforeDelivery: async () => {
      const action = beforeDelivery;
      beforeDelivery = undefined;
      action?.();
    },
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url!, "http://localhost")).catch(
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
    handler.close();
    await cache.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tree-layout`;
  const data = await archive.read();
  const input = {
    ...projectTree(data.family, new Set(data.family.people.map((p) => p.id))),
    mode: "generations" as const,
    reverse: false,
  };
  const body = {
    version: LAYOUT_CACHE_VERSION,
    hash: createHash("sha256").update(layoutCacheKey(input)).digest("hex"),
    reverse: false,
    people: input.people.map((p) => p.id),
  };
  const post = (value = body, headers = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(value),
    });
  assert.equal((await (await post()).json()).geometry, null);
  let ready: TreeGeometry | undefined;
  for (let i = 0; i < 100 && !ready; i++) {
    await delay(10);
    ready = (await (await post()).json()).geometry;
  }
  assert.equal(ready?.positions.length, 3);
  actor = { ...member, id: "second" };
  assert.deepEqual((await (await post()).json()).geometry, ready);
  assert.equal(calls, 1);
  actor = { ...actor, personId: "child", treeAccess: "common_ancestors" };
  assert.equal((await post()).status, 409); // Known hash cannot expose hidden IDs.
  actor = member;
  assert.equal((await post({ ...body, version: -1 })).status, 400);
  assert.equal(
    (await post(body, { Origin: "https://foreign.test" })).status,
    403,
  );
  beforeDelivery = () => {
    actor = null;
  };
  assert.equal((await post()).status, 409);
  assert.equal((await post()).status, 401); // Public viewing doesn't grant shared-cache access.
  actor = member;
  data.family.people[0].name = "Renamed";
  const written = await archive.write(data.family, data.revision);
  assert.deepEqual((await (await post()).json()).geometry, ready); // Text edits preserve the key.
  data.family.people.find((p) => p.id === "child")!.parents = [];
  await archive.write(data.family, written.revision);
  assert.equal((await post()).status, 409); // Relationship edits invalidate it.
  assert.equal(calls, 1);
});
