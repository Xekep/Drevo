import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "../src/server/database.ts";
import { mediaUploadHttp } from "../src/server/media-upload-http.ts";
import {
  preparationAdmission,
  PREPARATION_BYTES,
} from "../src/server/preparation-admission.ts";
import { WorkQueueBusyError } from "../src/server/work-queue.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { mediaStore } from "../src/server/media.ts";

test("HTTP uploads in separate archive handlers share one memory budget before reading/decode or acquiring quotas", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "drevo-http-shared-preparation-"),
  );
  const archives = await Promise.all(
    ["Archive A", "Archive B"].map((title) =>
      openArchive(":memory:", {
        title,
        description: "",
        demo: false,
        people: [],
      }),
    ),
  );
  const budget = preparationAdmission({ maximumWaiting: 0 });
  let releaseFirst: () => void = () => {},
    started: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  const reads = [0, 0];
  const owner = {
    id: "owner",
    name: "Owner",
    role: "admin",
    approved: true,
    createdAt: "",
  };
  const auth = {
    local: true,
    currentUser: async () => owner,
    canEdit: async () => true,
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  for (const archive of archives)
    await archive.db
      .prepare(
        "INSERT INTO users(id,name,role,approved) VALUES('owner','Owner','admin',1)",
      )
      .run();
  const revisions = await Promise.all(
    archives.map((archive) => archive.meta()),
  );
  const handlers = archives.map((archive, index) =>
    mediaUploadHttp({
      archive,
      auth,
      uploadsDirectory: directory,
      preparation: budget,
      media: {
        usage: async () => ({ files: 0, bytes: 0 }),
        async addStream(source: AsyncIterable<unknown>) {
          reads[index]++;
          for await (const chunk of source) assert.ok(Buffer.isBuffer(chunk));
          if (index === 0) {
            started();
            await gate;
          }
          throw new RangeError("Synthetic image rejected after preparation");
        },
      } as unknown as ReturnType<typeof mediaStore>,
    }),
  );
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const index = url.pathname.startsWith("/a/") ? 0 : 1;
    url.pathname = url.pathname.slice(2);
    void handlers[index](req, res, url).catch((error) => {
      if (res.destroyed) return;
      res.writeHead(error instanceof WorkQueueBusyError ? 503 : 500, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const upload = (index: number) =>
    fetch(`${origin}/${index ? "b" : "a"}/api/portraits`, {
      method: "POST",
      headers: {
        "x-drevo-upload": "1",
        "if-match": String(revisions[index].revision),
        "Content-Type": "image/png",
      },
      body: Buffer.from("synthetic-image"),
      signal: AbortSignal.timeout(10_000),
    });
  let first: Promise<Response> | undefined;
  try {
    first = upload(0);
    await Promise.race([
      reached,
      first.then((response) => {
        throw new Error(
          `Upload finished before preparation: ${response.status}`,
        );
      }),
    ]);
    assert.equal(budget.diagnostics().reservedBytes, PREPARATION_BYTES.image);
    assert.equal(
      archives[0].db.inTransaction(),
      false,
      "CPU work does not retain a quota transaction",
    );
    const denied = await upload(1);
    assert.equal(denied.status, 503);
    assert.equal(denied.headers.get("retry-after"), "2");
    await denied.text();
    assert.deepEqual(
      reads,
      [1, 0],
      "other archive did not start reading or decoding",
    );
    assert.equal(
      (await archives[1].db
        .prepare("SELECT count(*) AS n FROM document_upload_requests")
        .get())!.n,
      0,
    );
    releaseFirst();
    const completed = await first;
    assert.equal(completed.status, 400);
    await completed.text();
    assert.equal(budget.diagnostics().reservedBytes, 0);
    const recovered = await upload(1);
    assert.equal(recovered.status, 400);
    await recovered.text();
    assert.deepEqual(reads, [1, 1]);
    assert.equal(budget.diagnostics().active, 0);
  } finally {
    releaseFirst();
    await first?.then(
      (response) => (response.bodyUsed ? undefined : response.text()),
      () => {},
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    budget.close();
    await Promise.all(archives.map((archive) => archive.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
