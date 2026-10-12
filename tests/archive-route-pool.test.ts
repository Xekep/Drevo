import assert from "node:assert/strict";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { archiveRoutePool } from "../src/server/archive-route-pool.ts";

test("100 simultaneous distinct archives keep their active handlers without eviction", async () => {
  const responses: ServerResponse[] = [];
  let closed = 0;
  const pool = archiveRoutePool(
    async () => true,
    async (id) => ({
      async handle(_req, res) {
        responses.push(res);
        res.writeHead(200);
        res.write(id);
      },
      async close() {
        closed++;
      },
    }),
    { maxOpen: 128 },
  );
  const server = createServer((req, res) => {
    void pool.route(req, res, new URL(req.url!, "http://localhost"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        fetch(`${base}/a/probe-${i}/api/hold`),
      ),
    );
    assert.ok(results.every((result) => result.status === 200));
    assert.equal(pool.diagnostics().open, 100);
    assert.equal(pool.diagnostics().active, 100);
    assert.equal(closed, 0);
    responses.forEach((response) => response.end());
    await Promise.all(results.map((response) => response.text()));
  } finally {
    responses.forEach((response) => response.end());
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("disconnect does not evict a runtime whose background handler is still running", async () => {
  let finish!: () => void;
  let disconnected!: () => void;
  const work = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const detached = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  let firstClosed = false;
  const pool = archiveRoutePool(
    async () => true,
    async (id) => ({
      async handle(_req, res) {
        if (id === "tree-1") {
          res.on("close", disconnected);
          res.writeHead(200);
          res.write("started");
          await work;
        } else res.end(id);
      },
      async close() {
        if (id === "tree-1") firstClosed = true;
      },
    }),
    { maxOpen: 3 },
  );
  const server = createServer((req, res) => {
    void pool.route(req, res, new URL(req.url!, "http://localhost"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${base}/a/tree-1/api/hold`);
    await response.body!.cancel();
    await detached;
    for (const id of [2, 3, 4])
      await (await fetch(`${base}/a/tree-${id}/api/ready`)).text();
    const fifth = await fetch(`${base}/a/tree-5/api/ready`);
    assert.equal(await fifth.text(), "tree-5");
    assert.equal(firstClosed, false);
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await (await fetch(`${base}/a/tree-6/api/ready`)).text();
    assert.equal(firstClosed, true);
  } finally {
    finish();
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("scoped preview API and media stay in the selected archive runtime", async () => {
  const seen: Array<{ archiveId: string; path: string }> = [];
  const pool = archiveRoutePool(
    async (_req, archiveId, path) =>
      archiveId === "tree-123" && path.startsWith("/preview/member%3A42/"),
    async (archiveId) => ({
      async handle(_req, res, path) {
        seen.push({ archiveId, path });
        res.writeHead(200).end("selected");
      },
      async close() {},
    }),
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
    for (const path of [
      "api/family?projection=overview",
      "media/portrait.png",
    ]) {
      assert.equal(
        (await fetch(`${base}/a/tree-123/preview/member%3A42/${path}`)).status,
        200,
      );
    }
    assert.deepEqual(seen, [
      {
        archiveId: "tree-123",
        path: "/preview/member%3A42/api/family?projection=overview",
      },
      {
        archiveId: "tree-123",
        path: "/preview/member%3A42/media/portrait.png",
      },
    ]);
    assert.equal(
      (await fetch(`${base}/a/tree-456/preview/member%3A42/api/family`)).status,
      404,
      "the selected archive gate still applies",
    );
    assert.equal(
      (await fetch(`${base}/a/tree-123/preview/%2e%2e/api/family`)).status,
      404,
      "invalid preview member IDs never reach a runtime",
    );
  } finally {
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

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
  const fifthChecked = new Promise<void>((resolve) => {
    checkedFifth = resolve;
  });
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
  const openingStarted = new Promise<void>((resolve) => {
    opening = resolve;
  });
  const openingGate = new Promise<void>((resolve) => {
    finishOpening = resolve;
  });
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
        async close() {
          closed++;
        },
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

test("a failed access recheck after opening closes the runtime and propagates the error", async () => {
  const accessError = new Error("permission lookup failed");
  let failRecheck = false;
  let handled = 0;
  let closed = 0;
  let propagated: unknown;
  let opening!: () => void;
  let finishOpening!: () => void;
  const openingStarted = new Promise<void>((resolve) => {
    opening = resolve;
  });
  const openingGate = new Promise<void>((resolve) => {
    finishOpening = resolve;
  });
  const pool = archiveRoutePool(
    async () => {
      if (failRecheck) throw accessError;
      return true;
    },
    async () => {
      opening();
      await openingGate;
      return {
        async handle(_req, res) {
          handled++;
          res.end("archive");
        },
        async close() {
          closed++;
        },
      };
    },
  );
  const server = createServer((req, res) => {
    void pool
      .route(req, res, new URL(req.url!, "http://localhost"))
      .catch((error: unknown) => {
        propagated = error;
        res.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const pending = fetch(`${base}/a/private-tree/api/health`);
    await openingStarted;
    failRecheck = true;
    finishOpening();
    assert.equal((await pending).status, 500);
    assert.equal(propagated, accessError);
    assert.equal(handled, 0);
    assert.equal(closed, 1);
  } finally {
    finishOpening();
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function syntheticRequest(
  pool: ReturnType<typeof archiveRoutePool>,
  id: string,
  caller = "allowed",
) {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.headers["x-test-caller"] = caller;
  const res = new ServerResponse(req);
  const done = pool.route(
    req,
    res,
    new URL(`https://isolated.invalid/a/${id}/api/family`),
  );
  return { res, done };
}

test("100 cold archive startups run in bounded parallel batches instead of a serial 5-second queue", async () => {
  let active = 0,
    peak = 0,
    opened = 0;
  const pool = archiveRoutePool(
    async () => true,
    async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        await delay(180);
        opened++;
      } finally {
        active--;
      }
      return {
        handle: async (_req, res) => {
          res.end();
        },
        close: async () => {},
      };
    },
    { maxOpen: 128 },
  );
  try {
    const requests = Array.from({ length: 100 }, (_, i) =>
      syntheticRequest(pool, `cold-${i}`),
    );
    await Promise.all(requests.map((request) => request.done));
    assert.equal(opened, 100);
    assert.equal(peak, 4);
    assert.ok(requests.every(({ res }) => res.statusCode === 200));
    assert.equal(pool.diagnostics().open, 100);
    assert.equal(pool.diagnostics().opening, 0);
  } finally {
    await pool.close();
  }
});

test("same archive singleflight rechecks each caller and does not inherit the first caller's revoked grant", async () => {
  let finish!: () => void, began!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let firstAllowed = true,
    opened = 0,
    closed = 0;
  const handled: string[] = [];
  const pool = archiveRoutePool(
    async (req) => req.headers["x-test-caller"] !== "first" || firstAllowed,
    async () => {
      opened++;
      began();
      await gate;
      return {
        handle: async (req, res) => {
          handled.push(String(req.headers["x-test-caller"]));
          res.end();
        },
        close: async () => {
          closed++;
        },
      };
    },
  );
  try {
    const first = syntheticRequest(pool, "same-tree", "first");
    await started;
    const remaining = Array.from({ length: 30 }, () =>
      syntheticRequest(pool, "same-tree", "second"),
    );
    await delay(0);
    firstAllowed = false;
    finish();
    await Promise.all([
      first.done,
      ...remaining.map((request) => request.done),
    ]);
    assert.equal(first.res.statusCode, 404);
    assert.equal(opened, 1);
    assert.equal(handled.length, 30);
    assert.ok(handled.every((caller) => caller === "second"));
    assert.equal(closed, 0);
    assert.equal(pool.diagnostics().active, 0);
  } finally {
    finish();
    await pool.close();
  }
  assert.equal(closed, 1);
});

test("failed startup frees its capacity and singleflight so a later request can retry", async () => {
  let attempts = 0;
  const pool = archiveRoutePool(
    async () => true,
    async () => {
      if (++attempts === 1) throw new Error("isolated factory failure");
      return {
        handle: async (_req, res) => {
          res.end();
        },
        close: async () => {},
      };
    },
    { maxOpen: 1 },
  );
  try {
    await assert.rejects(
      syntheticRequest(pool, "retry-tree").done,
      /isolated factory failure/,
    );
    assert.equal(pool.diagnostics().opening, 0);
    const retry = syntheticRequest(pool, "retry-tree");
    await retry.done;
    assert.equal(retry.res.statusCode, 200);
    assert.equal(attempts, 2);
  } finally {
    await pool.close();
  }
});

test("shutdown rejects queued startups and closes an in-flight unpublishable runtime exactly once", async () => {
  let finish!: () => void, began!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let opened = 0,
    closed = 0,
    handled = 0;
  const pool = archiveRoutePool(
    async () => true,
    async () => {
      opened++;
      began();
      await gate;
      return {
        handle: async (_req, res) => {
          handled++;
          res.end();
        },
        close: async () => {
          closed++;
        },
      };
    },
    { maxOpen: 2, startupConcurrency: 1 },
  );
  const first = syntheticRequest(pool, "running-tree");
  await started;
  const queued = syntheticRequest(pool, "queued-tree");
  await delay(0);
  const shutdown = pool.close();
  finish();
  await Promise.all([first.done, queued.done, shutdown]);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(handled, 0);
  assert.equal(queued.res.statusCode, 503);
  assert.equal(pool.diagnostics().opening, 0);
});

test("capacity includes asynchronous close before another startup owns resources", async () => {
  let live = 0,
    peak = 0;
  const pool = archiveRoutePool(
    async () => true,
    async () => {
      live++;
      peak = Math.max(peak, live);
      return {
        handle: async (_req, res) => {
          res.end();
        },
        close: async () => {
          await delay(30);
          live--;
        },
      };
    },
    { maxOpen: 2 },
  );
  try {
    await Promise.all([
      syntheticRequest(pool, "initial-1").done,
      syntheticRequest(pool, "initial-2").done,
    ]);
    await Promise.all(
      Array.from(
        { length: 8 },
        (_, i) => syntheticRequest(pool, `replace-${i}`).done,
      ),
    );
    assert.equal(peak, 2);
    assert.equal(pool.diagnostics().opening, 0);
  } finally {
    await pool.close();
  }
  assert.equal(live, 0);
});

test("disconnected queued callers release their singleflight without aborting another caller of that archive", async () => {
  let finish!: () => void, began!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const opened: string[] = [];
  const pool = archiveRoutePool(
    async () => true,
    async (id) => {
      opened.push(id);
      if (id === "holding-tree") {
        began();
        await gate;
      }
      return {
        handle: async (_req, res) => {
          res.end();
        },
        close: async () => {},
      };
    },
    { startupConcurrency: 1 },
  );
  try {
    const holding = syntheticRequest(pool, "holding-tree");
    await started;
    const abandoned = syntheticRequest(pool, "waiting-tree");
    await delay(0);
    abandoned.res.destroy();
    abandoned.res.emit("close");
    await abandoned.done;
    const retry = syntheticRequest(pool, "waiting-tree");
    await delay(0);
    finish();
    await Promise.all([holding.done, retry.done]);
    assert.equal(retry.res.statusCode, 200);
    assert.deepEqual(opened, ["holding-tree", "waiting-tree"]);
    assert.equal(pool.diagnostics().active, 0);
  } finally {
    finish();
    await pool.close();
  }
});

test("all revoked startup waiters close the created runtime once without publishing private data", async () => {
  let finish!: () => void, began!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let allowed = true,
    closed = 0,
    handled = 0;
  const pool = archiveRoutePool(
    async () => allowed,
    async () => {
      began();
      await gate;
      return {
        handle: async (_req, res) => {
          handled++;
          res.end();
        },
        close: async () => {
          closed++;
        },
      };
    },
  );
  try {
    const request = syntheticRequest(pool, "revoked-tree");
    await started;
    allowed = false;
    finish();
    await request.done;
    assert.equal(request.res.statusCode, 404);
    assert.equal(closed, 1);
    assert.equal(handled, 0);
    assert.equal(pool.diagnostics().open, 0);
    assert.equal(pool.diagnostics().opening, 0);
  } finally {
    finish();
    await pool.close();
  }
  assert.equal(closed, 1);
});

test(
  "an unrelated warm archive does not wait for another archive's cold factory",
  { timeout: 5000 },
  async () => {
    let finish!: () => void, began!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let coldFinished = false;
    const pool = archiveRoutePool(
      async () => true,
      async (id) => {
        if (id === "cold-tree") {
          began();
          await gate;
          coldFinished = true;
        }
        return {
          handle: async (_req, res) => {
            res.end();
          },
          close: async () => {},
        };
      },
      { maxOpen: 2, startupConcurrency: 1 },
    );
    let cold: ReturnType<typeof syntheticRequest> | undefined;
    try {
      await syntheticRequest(pool, "warm-tree").done;
      cold = syntheticRequest(pool, "cold-tree");
      await started;
      const warm = syntheticRequest(pool, "warm-tree");
      await warm.done;
      assert.equal(warm.res.statusCode, 200);
      assert.equal(coldFinished, false);
    } finally {
      finish();
      await cold?.done;
      await pool.close();
    }
  },
);
