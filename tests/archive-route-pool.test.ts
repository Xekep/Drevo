import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { archiveRoutePool } from "../src/server/archive-route-pool.ts";

test("a fifth tree waits for an active tree instead of losing the request", async () => {
  const held = new Map<string, ServerResponse>();
  const opened: string[] = [];
  const pool = archiveRoutePool(
    async () => true,
    async (id) => {
      opened.push(id);
      return {
        async handle(_req, res, path) {
          if (path === "/api/hold") {
            held.set(id, res);
            res.writeHead(200);
            res.write("held");
          } else res.end(id);
        },
        async close() {},
      };
    },
  );
  const server = createServer((req, res) => {
    void pool
      .route(req, res, new URL(req.url!, "http://localhost"))
      .then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const holding = await Promise.all(
      [1, 2, 3, 4].map((number) => fetch(`${base}/a/tree-${number}/api/hold`)),
    );
    assert.equal(held.size, 4);
    const fifth = fetch(`${base}/a/tree-5/api/ready`);
    const early = await Promise.race([
      fifth.then(() => "finished"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("waiting"), 100),
      ),
    ]);
    assert.equal(early, "waiting");
    held.get("tree-1")!.end();
    assert.equal((await fifth).status, 200);
    assert.ok(opened.includes("tree-5"));
    for (const response of held.values())
      if (!response.writableEnded) response.end();
    await Promise.all(holding.map((response) => response.text()));
  } finally {
    for (const response of held.values())
      if (!response.writableEnded) response.end();
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a warm archive still checks access on every request", async () => {
  let permitted = true;
  let opened = 0;
  let handled = 0;
  const pool = archiveRoutePool(
    async () => permitted,
    async () => {
      opened++;
      return {
        async handle(_req, res) {
          handled++;
          res.writeHead(200).end("archive");
        },
        async close() {},
      };
    },
  );
  const server = createServer((req, res) => {
    void pool.route(req, res, new URL(req.url!, "http://localhost"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const url = `${base}/a/private-tree/api/health`;
    assert.equal((await fetch(url)).status, 200);
    permitted = false;
    assert.equal((await fetch(url)).status, 404);
    assert.equal(handled, 1);
    permitted = true;
    assert.equal((await fetch(url)).status, 200);
    assert.equal(opened, 1);
  } finally {
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("revocation while a fifth archive waits prevents its runtime from opening", async () => {
  const held = new Map<string, ServerResponse>();
  const opened: string[] = [];
  let permitted = true;
  let checkedFifth!: () => void;
  const fifthChecked = new Promise<void>((resolve) => { checkedFifth = resolve; });
  const pool = archiveRoutePool(
    async (_req, id) => {
      if (id === "tree-5") checkedFifth();
      return permitted;
    },
    async (id) => {
      opened.push(id);
      return {
        async handle(_req, res, path) {
          if (path === "/api/hold") {
            held.set(id, res);
            res.writeHead(200);
            res.write("held");
          } else res.end("archive");
        },
        async close() {},
      };
    },
  );
  const server = createServer((req, res) => {
    void pool.route(req, res, new URL(req.url!, "http://localhost"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const holding = await Promise.all(
      [1, 2, 3, 4].map((number) => fetch(`${base}/a/tree-${number}/api/hold`)),
    );
    const fifth = fetch(`${base}/a/tree-5/api/health`);
    await fifthChecked;
    permitted = false;
    held.get("tree-1")!.end();
    assert.equal((await fifth).status, 404);
    assert.equal(opened.includes("tree-5"), false);
    for (const response of held.values())
      if (!response.writableEnded) response.end();
    await Promise.all(holding.map((response) => response.text()));
  } finally {
    for (const response of held.values())
      if (!response.writableEnded) response.end();
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("revocation during archive opening closes it without dispatching", async () => {
  let permitted = true;
  let handled = 0;
  let closed = 0;
  let opening!: () => void;
  let finishOpening!: () => void;
  const openingStarted = new Promise<void>((resolve) => { opening = resolve; });
  const openingGate = new Promise<void>((resolve) => { finishOpening = resolve; });
  const pool = archiveRoutePool(
    async () => permitted,
    async () => {
      opening();
      await openingGate;
      return {
        async handle(_req, res) {
          handled++;
          res.end("archive");
        },
        async close() { closed++; },
      };
    },
  );
  const server = createServer((req, res) => {
    void pool.route(req, res, new URL(req.url!, "http://localhost"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const pending = fetch(`${base}/a/private-tree/api/health`);
    await openingStarted;
    permitted = false;
    finishOpening();
    assert.equal((await pending).status, 404);
    assert.equal(handled, 0);
    assert.equal(closed, 1);
  } finally {
    finishOpening();
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
