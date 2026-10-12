import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { workQueue } from "../src/server/work-queue.ts";
import { archiveSnapshotBudget } from "../src/server/archive-read-cache.ts";
import { adaptLegacyAiFake } from "./legacy-ai-fake.ts";
import {
  preparationAdmission,
  pendingAiAdmission,
} from "../src/server/preparation-admission.ts";
import { tiffDocumentRenderer } from "../src/server/document-images.ts";

test("HTTP AI queue rejects overflow and stop removes a queued chat before calling the provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-ai-queue-"));
  const keys = ["YANDEX_AI_API_KEY", "YANDEX_AI_FOLDER_ID", "YANDEX_AI_MODEL"];
  const prior = keys.map((key) => process.env[key]);
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "test-folder";
  process.env.YANDEX_AI_MODEL = "test-model";
  const ai = workQueue(1, 1);
  const previews = workQueue(2, 32);
  const preparation = preparationAdmission();
  const pendingAi = pendingAiAdmission();
  const tiff = tiffDocumentRenderer(preparation);
  const mediaScans = workQueue(1, 128, 30_000);
  const release = await ai.acquire();
  let calls = 0;
  const provider = adaptLegacyAiFake(async () => {
    calls++;
    return Response.json({
      choices: [
        {
          message: { role: "assistant", content: "Здравствуйте!" },
          finish_reason: "stop",
        },
      ],
    });
  });
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer(
      0,
      join(directory, "archive.sqlite"),
      true,
      undefined,
      provider,
      undefined,
      undefined,
      undefined,
      {
        ai,
        previews,
        snapshots: archiveSnapshotBudget(),
        preparation,
        pendingAi,
        tiff,
        mediaScans,
      },
    );
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const send = (path: string, message: string) =>
      fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, context: { view: "tree" } }),
      });
    const queued = await send("/api/ai/chat/stream", "Первый запрос");
    assert.equal(queued.status, 200);
    const queuedBody = queued.text();
    const deadline = Date.now() + 5000;
    while (!ai.diagnostics().queued && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ai.diagnostics().queued, 1);
    const list = await (await fetch(base + "/api/ai/chats")).json();
    const id = list.chats[0].id as string;
    const overflow = await send("/api/ai/chat", "Второй запрос");
    assert.equal(overflow.status, 503, await overflow.text());
    assert.equal(calls, 0);
    const stopped = await fetch(`${base}/api/ai/chats/${id}/stop`, {
      method: "POST",
    });
    assert.equal(stopped.status, 200, await stopped.text());
    const stream = await queuedBody;
    assert.match(stream, /Ожидаю свободное место/);
    assert.equal(ai.diagnostics().queued, 0);
    assert.equal(calls, 0, "stopped waiting work must never reach the model");
    release();
    const next = await send("/api/ai/chat", "Привет");
    assert.equal(next.status, 200, await next.text());
    assert.equal(calls, 1);
    assert.equal(ai.diagnostics().active, 0);
  } finally {
    release();
    ai.close();
    previews.close();
    await app?.close();
    await tiff.close();
    pendingAi.close();
    mediaScans.close();
    preparation.close();
    await preparation.drain();
    keys.forEach((key, i) => {
      if (prior[i] === undefined) delete process.env[key];
      else process.env[key] = prior[i];
    });
    await rm(directory, { recursive: true, force: true });
  }
});
