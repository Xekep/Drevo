import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionStaticHttp } from "../src/server/production-static-http.ts";

async function listen(
  handler: ReturnType<typeof productionStaticHttp>,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    void handler(req, res, url).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(418, { "Content-Type": "text/plain" });
        res.end("next handler");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("production static streams SPA routes, files and shared page", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-production-static-"));
  mkdirSync(join(directory, "assets"), { recursive: true });
  const html = "<!doctype html><title>Drevo</title>";
  const icon = "<svg></svg>";
  writeFileSync(join(directory, "index.html"), html);
  writeFileSync(join(directory, "favicon.svg"), icon);
  const app = await listen(productionStaticHttp(directory, true));
  const token = "a".repeat(43);

  try {
    for (const path of ["/", "/tree", "/people"]) {
      const response = await fetch(app.base + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(response.headers.get("cache-control"), "no-cache");
      assert.equal(await response.text(), html);
    }

    const favicon = await fetch(app.base + "/favicon.svg");
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get("content-type"), "image/svg+xml");
    assert.equal(await favicon.text(), icon);

    const shared = await fetch(app.base + `/s/${token}`);
    assert.equal(shared.status, 200);
    assert.equal(shared.headers.get("referrer-policy"), "no-referrer");
    assert.equal(shared.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.equal(await shared.text(), html);

    const head = await fetch(app.base + "/tree", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(html)));
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    assert.equal((await fetch(app.base + "/missing.txt")).status, 404);
    const api = await fetch(app.base + "/api/health");
    assert.equal(api.status, 418);
    assert.equal(await api.text(), "next handler");
    assert.equal((await fetch(app.base + "/auth/yandex")).status, 418);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production static stays disabled for dev pages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-dev-static-"));
  mkdirSync(join(directory, "assets"), { recursive: true });
  writeFileSync(join(directory, "index.html"), "built app");
  const app = await listen(productionStaticHttp(directory, false));
  try {
    const response = await fetch(app.base + "/tree");
    assert.equal(response.status, 418);
    assert.equal(await response.text(), "next handler");
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production static handler does not synchronously read request files", () => {
  const source = readFileSync("src/server/production-static-http.ts", "utf8");
  assert.doesNotMatch(source, /readFileSync|existsSync/);
  assert.match(source, /openFile\s*\(/);
  assert.match(source, /pipeline\s*\(/);
});
