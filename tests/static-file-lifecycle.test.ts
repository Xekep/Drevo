import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createServer, request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticAssetsHttp } from "../src/server/static-assets-http.ts";
import { productionStaticHttp } from "../src/server/production-static-http.ts";

for (const assets of [true, false]) {
  test(`cancelled ${assets ? "asset" : "public file"} responses close every file before returning`, async (t) => {
    const directory = fs.mkdtempSync(join(tmpdir(), "drevo-static-close-"));
    fs.mkdirSync(join(directory, "models"));
    fs.writeFileSync(join(directory, "app.js"), Buffer.alloc(256 * 1024, 0x61));
    fs.writeFileSync(join(directory, "models", "model.bin"), Buffer.alloc(256 * 1024));
    const opened: FileHandle[] = [];
    const original = fs.promises.open.bind(fs.promises);
    const opening = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      opened.push(handle);
      return handle;
    });
    syncBuiltinESMExports();
    const handler = assets ? staticAssetsHttp(directory) : productionStaticHttp(directory, true);
    const active = new Set<Promise<unknown>>();
    const server = createServer((req, res) => {
      // A browser can abandon a lazy chunk before async open/stat completes.
      res.destroy();
      const pending = handler(req, res, new URL(req.url!, "http://localhost"));
      active.add(pending);
      void pending.finally(() => active.delete(pending));
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      await Promise.all(Array.from({ length: 12 }, () => new Promise<void>((resolve) => {
        const client = request({ host: "127.0.0.1", port, path: assets ? "/assets/app.js" : "/models/model.bin" });
        client.on("error", () => resolve());
        client.end();
      })));
      await Promise.all([...active]);
      assert.equal(opened.length, 12);
      assert.ok(opened.every((handle) => handle.fd === -1), "an abandoned response retained an open file");
    } finally {
      await Promise.all(opened.map((handle) => handle.close()));
      opening.mock.restore();
      syncBuiltinESMExports();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
