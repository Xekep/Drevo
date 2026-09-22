import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

test("admin can save encrypted AI Studio credentials and select a model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-admin-")),
    databasePath = join(dir, "drevo.sqlite"),
    secret = "AQVN-test-secret-key-123456789";
  for (const key of [
    "YANDEX_AI_API_KEY",
    "YANDEX_AI_FOLDER_ID",
    "YANDEX_AI_MODEL",
  ])
    delete process.env[key];

  const yandexModel = "gpt://folder-1/yandexgpt-5.1/latest",
    deepseekModel = "gpt://folder-1/deepseek-v4-flash/latest",
    requests: Array<{
      body: Record<string, unknown>;
      authorization: string;
      project: string;
    }> = [],
    modelRequests: Array<{ authorization: string; project: string }> = [];
  const aiFetch: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (String(url).endsWith("/models")) {
      modelRequests.push({
        authorization: headers.get("Authorization") || "",
        project: headers.get("x-project") || "",
      });
      return Response.json({
        object: "list",
        data: [
          { id: "emb://folder-1/text-embeddings/latest", owned_by: "Yandex" },
          { id: yandexModel, owned_by: "Yandex" },
          { id: deepseekModel, owned_by: "Yandex" },
        ],
      });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({
      body,
      authorization: headers.get("Authorization") || "",
      project: headers.get("OpenAI-Project") || "",
    });
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: "OK",
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      },
    });
  };

  const app = await startServer(0, databasePath, true, undefined, aiFetch),
    base =
      "http://127.0.0.1:" + (app.server.address() as { port: number }).port;

  try {
    const initial = await fetch(base + "/api/admin/ai").then((response) =>
      response.json(),
    );
    assert.equal(initial.enabled, true);
    assert.equal(initial.active, false);
    assert.equal(initial.configured, false);
    assert.equal(initial.apiKeyConfigured, false);
    assert.equal(initial.folderConfigured, false);
    assert.equal(initial.model, "");
    assert.deepEqual(initial.models, []);

    const discoveredResponse = await fetch(base + "/api/admin/ai/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: "folder-1", apiKey: secret }),
    });
    assert.equal(discoveredResponse.status, 200);
    const discoveredText = await discoveredResponse.text(),
      discovered = JSON.parse(discoveredText);
    assert.equal(discoveredText.includes(secret), false);
    assert.deepEqual(
      discovered.models.map((item: { id: string }) => item.id),
      [deepseekModel, yandexModel],
    );
    assert.equal(modelRequests.at(-1)?.authorization, "Api-Key " + secret);
    assert.equal(modelRequests.at(-1)?.project, "folder-1");

    const savedResponse = await fetch(base + "/api/admin/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        apiKey: secret,
        folderId: "folder-1",
        model: yandexModel,
        requestsPerMinute: 1,
        dailyRequests: 10,
        dailyTokens: 1000,
      }),
    });
    assert.equal(savedResponse.status, 200);
    const savedText = await savedResponse.text(),
      saved = JSON.parse(savedText);
    assert.equal(savedText.includes(secret), false);
    assert.equal(saved.active, true);
    assert.equal(saved.apiKeyConfigured, true);
    assert.equal(saved.apiKeyStored, true);
    assert.equal(saved.apiKeySource, "database");
    assert.equal(saved.folderId, "folder-1");
    assert.equal(saved.folderSource, "database");
    assert.equal(saved.model, yandexModel);
    assert.equal(saved.modelSource, "database");
    assert.deepEqual(
      saved.models.map((item: { id: string }) => item.id),
      [deepseekModel, yandexModel],
    );
    assert.deepEqual(saved.limits, {
      requestsPerMinute: 1,
      dailyRequests: 10,
      dailyTokens: 1000,
    });

    const row = app.archive.db
      .prepare(
        "SELECT api_key_ciphertext,folder_id FROM ai_settings WHERE id=1",
      )
      .get()!;
    assert.equal(String(row.folder_id), "folder-1");
    assert.match(String(row.api_key_ciphertext), /^v1\./);
    assert.equal(String(row.api_key_ciphertext).includes(secret), false);

    const keyPath = databasePath + ".secrets.key";
    assert.equal(existsSync(keyPath), true);
    assert.equal(readFileSync(keyPath).length, 32);

    const auditText = JSON.stringify(
      app.archive.db.prepare("SELECT * FROM audit_entries").all(),
    );
    assert.equal(auditText.includes(secret), false);

    const tested = await fetch(base + "/api/admin/ai/test", {
      method: "POST",
    });
    assert.equal(tested.status, 200);
    assert.equal((await tested.json()).ok, true);
    assert.equal(requests.at(-1)?.authorization, "Api-Key " + secret);
    assert.equal(requests.at(-1)?.project, "folder-1");
    assert.equal(requests.at(-1)?.body.model, yandexModel);

    const chat = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Проверка",
        context: { view: "tree", personIds: [] },
      }),
    });
    assert.equal(chat.status, 200);
    assert.equal(requests.at(-1)?.body.model, yandexModel);

    const usageStatus = await fetch(base + "/api/admin/ai").then((response) =>
      response.json(),
    );
    assert.equal(usageStatus.usage.today.requests, 1);
    assert.equal(usageStatus.usage.today.providerCalls, 1);
    assert.equal(usageStatus.usage.today.inputTokens, 12);
    assert.equal(usageStatus.usage.today.outputTokens, 3);
    assert.equal(usageStatus.usage.today.totalTokens, 15);
    assert.equal(usageStatus.usage.history.length, 14);
    assert.deepEqual(usageStatus.usage.history.at(-1), {
      day: new Date().toISOString().slice(0, 10),
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    });

    const beforeLimitedChat = requests.length;
    const limitedChat = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Второй запрос слишком быстро" }),
    });
    assert.equal(limitedChat.status, 429);
    assert.equal(requests.length, beforeLimitedChat);

    const disabledResponse = await fetch(base + "/api/admin/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        folderId: "folder-1",
        model: deepseekModel,
        requestsPerMinute: 1,
        dailyRequests: 10,
        dailyTokens: 1000,
      }),
    });
    assert.equal(disabledResponse.status, 200);
    const disabled = await disabledResponse.json();
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.active, false);
    assert.equal(disabled.configured, true);
    assert.equal(disabled.model, deepseekModel);

    const clearedResponse = await fetch(base + "/api/admin/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        clearApiKey: true,
        folderId: "folder-1",
        model: deepseekModel,
        requestsPerMinute: 1,
        dailyRequests: 10,
        dailyTokens: 1000,
      }),
    });
    assert.equal(clearedResponse.status, 200);
    const cleared = await clearedResponse.json();
    assert.equal(cleared.apiKeyStored, false);
    assert.equal(cleared.apiKeyConfigured, false);
    assert.equal(cleared.configured, false);
    assert.equal(
      String(
        app.archive.db
          .prepare("SELECT api_key_ciphertext FROM ai_settings WHERE id=1")
          .get()!.api_key_ciphertext,
      ),
      "",
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
