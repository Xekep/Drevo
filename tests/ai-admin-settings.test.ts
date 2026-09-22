import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

test("admin AI settings update model live, test connection, and can disable researcher", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-admin-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";

  const requests: Array<Record<string, unknown>> = [];
  const aiFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: "OK",
          },
        },
      ],
    });
  };

  const app = await startServer(
      0,
      join(dir, "drevo.sqlite"),
      true,
      undefined,
      aiFetch,
    ),
    base =
      "http://127.0.0.1:" +
      (app.server.address() as { port: number }).port;

  try {
    const initial = await fetch(base + "/api/admin/ai").then((response) =>
      response.json(),
    );
    assert.equal(initial.enabled, true);
    assert.equal(initial.active, true);
    assert.equal(initial.configured, true);
    assert.equal(initial.apiKeyConfigured, true);
    assert.equal(initial.folderConfigured, true);
    assert.equal(initial.model, "yandexgpt/rc");
    assert.equal(initial.modelOverride, "");

    const savedResponse = await fetch(base + "/api/admin/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        model: "yandexgpt/latest",
      }),
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.active, true);
    assert.equal(saved.model, "yandexgpt/latest");
    assert.equal(saved.modelOverride, "yandexgpt/latest");
    assert.equal(saved.modelSource, "database");

    const tested = await fetch(base + "/api/admin/ai/test", {
      method: "POST",
    });
    assert.equal(tested.status, 200);
    assert.equal((await tested.json()).ok, true);
    assert.equal(
      requests.at(-1)?.model,
      "gpt://folder-1/yandexgpt/latest",
    );

    const chat = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Проверка",
        context: { view: "tree", personIds: [] },
      }),
    });
    assert.equal(chat.status, 200);
    assert.equal(
      requests.at(-1)?.model,
      "gpt://folder-1/yandexgpt/latest",
    );

    const disabledResponse = await fetch(base + "/api/admin/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        model: "yandexgpt/latest",
      }),
    });
    assert.equal(disabledResponse.status, 200);
    const disabled = await disabledResponse.json();
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.active, false);
    assert.equal(disabled.configured, true);

    const status = await fetch(base + "/api/ai/status").then((response) =>
      response.json(),
    );
    assert.equal(status.enabled, false);

    const beforeBlockedChat = requests.length;
    const blockedChat = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Этот запрос не должен уйти в AI Studio",
      }),
    });
    assert.equal(blockedChat.status, 503);
    assert.equal(requests.length, beforeBlockedChat);
    assert.match((await blockedChat.json()).error, /отключён/);
  } finally {
    await app.close();
    for (const key of [
      "YANDEX_AI_API_KEY",
      "YANDEX_AI_FOLDER_ID",
      "YANDEX_AI_MODEL",
    ])
      delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  }
});
