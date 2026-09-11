import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticAssetsHttp } from "../src/server/static-assets-http.ts";

test("static assets stream GET and support HEAD with immutable cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-assets-"));
  const bytes = Buffer.alloc(256 * 1024, 0x61);
  writeFileSync(join(directory, "app-123.js"), bytes);
  const serveAsset = staticAssetsHttp(directory);
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    void serveAsset(req, res, url).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    const get = await fetch(base + "/assets/app-123.js");
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(get.headers.get("content-length"), String(bytes.length));
    assert.equal(
      get.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);

    const head = await fetch(base + "/assets/app-123.js", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const post = await fetch(base + "/assets/app-123.js", { method: "POST" });
    assert.equal(post.status, 405);

    const traversal = await fetch(base + "/assets/%2E%2E%2Fsecret.txt");
    assert.equal(traversal.status, 403);
    assert.equal((await fetch(base + "/assets/missing.js")).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("static asset handler does not synchronously read request files", () => {
  const source = readFileSync("src/server/static-assets-http.ts", "utf8");
  assert.doesNotMatch(source, /readFileSync/);
  assert.match(source, /openFile\s*\(/);
  assert.match(source, /pipeline\s*\(/);
});
