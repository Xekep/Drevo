import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { startServer } from "../src/server/index.ts";

for (const scenario of [
  "invalid PDF",
  "invalid image",
  "valid image",
] as const) {
  test(`document upload waits for cleanup before responding: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "drevo-upload-cleanup-"));
    const app = await startServer(0, join(directory, "drevo.sqlite"), true);
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const prepare = app.archive.db.prepare.bind(app.archive.db);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let entered!: () => void;
    const cleaning = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let response: ServerResponse | undefined;
    app.server.on("request", (_req, res) => {
      response = res;
    });
    app.archive.db.prepare = (sqlite, postgres) => {
      const statement = prepare(sqlite, postgres);
      if (
        sqlite !==
        "UPDATE document_upload_requests SET reserved_bytes=0 WHERE id=?"
      )
        return statement;
      return {
        ...statement,
        async run(...values) {
          entered();
          await gate;
          return statement.run(...values);
        },
      };
    };
    let request: Promise<Response> | undefined;
    try {
      const bytes =
        scenario === "valid image"
          ? await sharp({
              create: { width: 2, height: 2, channels: 3, background: "white" },
            })
              .png()
              .toBuffer()
          : Buffer.from("not a document");
      request = fetch(`${base}/api/documents`, {
        method: "POST",
        headers: {
          "Content-Type":
            scenario === "invalid PDF" ? "application/pdf" : "image/png",
          "X-Document-Metadata": encodeURIComponent(
            JSON.stringify({ title: "Test", personIds: [] }),
          ),
        },
        body: new Uint8Array(bytes).buffer,
        signal: AbortSignal.timeout(10_000),
      });
      await Promise.race([
        cleaning,
        request.then(() => {
          throw new Error("Response escaped before cleanup started");
        }),
      ]);
      assert.ok(response);
      assert.equal(
        response.headersSent,
        false,
        "cleanup is deliberately blocked; the client must not receive a final response yet",
      );
      assert.equal(response.writableEnded, false);
      unblock();
      const result = await request;
      assert.equal(
        result.status,
        scenario === "valid image" ? 201 : 415,
        await result.clone().text(),
      );
      const files = await readdir(join(directory, "uploads"));
      assert.deepEqual(
        files.filter((file) => file.endsWith(".upload")),
        [],
      );
      assert.equal(
        Number(
          (await prepare(
            "SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM document_upload_requests",
          ).get())!.bytes,
        ),
        0,
      );
      const rows = await prepare("SELECT id,file_name FROM documents").all();
      if (scenario === "valid image") {
        const body = (await result.json()) as { id: string };
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, body.id);
        assert.ok(
          files.includes(String(rows[0].file_name)),
          "cleanup must retain the committed original",
        );
      } else {
        assert.deepEqual(rows, []);
        assert.deepEqual(
          files,
          [],
          "a rejected document must leave no original or staging file",
        );
      }
    } finally {
      unblock();
      await request?.catch(() => {});
      app.archive.db.prepare = prepare;
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
