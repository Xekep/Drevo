import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { archiveCanonicalHttp } from "../src/server/archive-canonical-http.ts";
import { archivePagePath } from "../src/domain/archive-context.ts";
import { accountArchivesHttp } from "../src/server/account-archives-http.ts";

test("public archive paths use the configured primary, not a hardcoded legacy name", () => {
  assert.equal(
    archivePagePath("legacy-primary", "/tree", "legacy-primary"),
    "/tree",
  );
  assert.equal(
    archivePagePath("main-tree", "/people/person-one", "main-tree"),
    "/people/person-one",
  );
  assert.equal(
    archivePagePath("legacy-primary", "/tree", "main-tree"),
    "/a/legacy-primary/tree",
  );
  assert.equal(
    archivePagePath("other-tree", "/tree", "main-tree"),
    "/a/other-tree/tree",
  );
  assert.equal(archivePagePath(undefined, "/s/token", "main-tree"), "/s/token");
});

test("old primary page bookmarks redirect without changing API, previews or another tree's scope", async () => {
  const canonical = archiveCanonicalHttp("main-tree");
  const server = createServer((req, res) => {
    if (
      !canonical(req, res, new URL(req.url || "/", "https://drevo.invalid"))
    ) {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const [source, target] of [
      ["/a/main-tree/tree?layout=depth", "/tree?layout=depth"],
      ["/a/main-tree/people/person-one", "/people/person-one"],
      ["/a/main-tree/photos/photo-one", "/photos/photo-one"],
      [
        "/a/main-tree/documents/11111111-1111-4111-8111-111111111111",
        "/documents/11111111-1111-4111-8111-111111111111",
      ],
      ["/a/main-tree/admin?section=members", "/manage?section=members"],
      ["/a/main-tree/preview/member-one/tree", "/preview/member-one/tree"],
      [`/a/main-tree/s/${"a".repeat(43)}`, `/s/${"a".repeat(43)}`],
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(base + source, {
          method,
          redirect: "manual",
        });
        assert.equal(response.status, 308, `${method} ${source}`);
        assert.equal(response.headers.get("location"), target);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      }
    }
    for (const path of [
      "/a/other-tree/tree",
      "/a/main-tree/api/family",
      "/a/main-tree/media/photo.jpg",
      "/a/main-tree/preview/member-one/api/family",
      "/a/main-tree/preview/member-one/admin",
      "/a/main-tree//evil.invalid/tree",
      "/a/main-tree/unknown",
      "/tree",
      `/join/other-tree/${"b".repeat(43)}`,
    ]) {
      const response = await fetch(base + path, { redirect: "manual" });
      assert.equal(response.status, 204, path);
      assert.equal(response.headers.get("location"), null);
    }
    assert.equal(
      (
        await fetch(base + "/a/main-tree/tree", {
          method: "POST",
          redirect: "manual",
        })
      ).status,
      204,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the archive directory returns canonical links without mutating the locked membership snapshot", async () => {
  const archives = [
    {
      id: "main-tree",
      title: "Main",
      role: "reader" as const,
      current: false,
      approved: true,
      owned: false,
    },
    {
      id: "other-tree",
      title: "Other",
      role: "relative" as const,
      current: true,
      approved: true,
      owned: true,
    },
  ];
  const snapshot = structuredClone(archives);
  const directory = {
    list: async () => archives,
    async deliverList(
      _account: string,
      _token: string,
      expected: unknown,
      deliver: () => Promise<void>,
    ) {
      assert.deepEqual(expected, snapshot);
      await deliver();
    },
  } as unknown as Parameters<typeof accountArchivesHttp>[1];
  const auth = {
    accountSession: async () => ({ accountId: "reader", tokenHash: "session" }),
  } as unknown as Parameters<typeof accountArchivesHttp>[0];
  const handler = accountArchivesHttp(
    auth,
    directory,
    { kind: "postgres" } as Parameters<typeof accountArchivesHttp>[2],
    undefined,
    false,
    "main-tree",
  );
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url!, "https://drevo.invalid"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/api/account/archives`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).archives.map(
        (item: { href: string }) => item.href,
      ),
      ["/tree", "/a/other-tree/tree"],
    );
    assert.deepEqual(archives, snapshot);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
