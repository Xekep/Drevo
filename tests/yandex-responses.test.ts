import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import {
  missingYandexConversation,
  parseYandexResponse,
  YandexResponseError,
  yandexResponsesClient,
} from "../src/server/yandex-responses.ts";

test("Responses parser keeps each function call and provider token usage", () => {
  const response = parseYandexResponse({
    id: "resp-1",
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: "call-a",
        name: "search_people",
        arguments: '{"query":"Анна"}',
      },
      {
        type: "function_call",
        call_id: "call-b",
        name: "get_archive_insights",
        arguments: "{}",
      },
    ],
    usage: {
      input_tokens: 120,
      output_tokens: 40,
      input_tokens_details: { cached_tokens: 80 },
    },
  });
  assert.deepEqual(
    response.calls.map((call) => call.call_id),
    ["call-a", "call-b"],
  );
  assert.equal(response.inputTokens, 120);
  assert.equal(response.cachedTokens, 80);
});

test("only a missing conversation triggers recovery", () => {
  assert.equal(
    missingYandexConversation(
      new YandexResponseError("Conversation not found", 404),
    ),
    true,
  );
  assert.equal(
    missingYandexConversation(new YandexResponseError("Model not found", 404)),
    false,
  );
  assert.throws(
    () =>
      parseYandexResponse({ id: "pending", status: "in_progress", output: [] }),
    /не завершила ответ/,
  );
});

test("Responses client sends documented compaction, truncation and call outputs", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = yandexResponsesClient(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(url), body });
    return Response.json({
      id: "resp-1",
      status: "completed",
      output_text: "Готово",
      output: [],
    });
  });
  await client.respond({
    runtime: {
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      folderId: "folder",
      modelUri: "gpt://folder/model",
    },
    conversationId: "conversation-1",
    input: [
      { type: "message", role: "user", content: "Вопрос" },
      { type: "message", role: "assistant", content: "Старый ответ" },
      {
        type: "function_call_output",
        call_id: "call-a",
        output: '{"found":true}',
      },
    ],
    instructions: "Проверь данные",
    tools: [],
    compactThreshold: 32000,
    automaticTruncation: true,
  });
  assert.equal(requests[0].url, "https://example.test/v1/responses");
  assert.equal(requests[0].body.conversation, "conversation-1");
  assert.deepEqual(requests[0].body.context_management, {
    type: "compaction",
    compact_threshold: 32000,
  });
  assert.equal(requests[0].body.truncation, "auto");
  assert.deepEqual(requests[0].body.input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Вопрос" }],
    },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Старый ответ" }],
    },
    {
      type: "function_call_output",
      call_id: "call-a",
      output: '{"found":true}',
    },
  ]);
  assert.equal("previous_response_id" in requests[0].body, false);
});

test("provider rejection of compaction falls back once and remembers the model", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = yandexResponsesClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.context_management)
      return Response.json(
        { error: { message: "Bad Request: Failed to read request" } },
        { status: 400 },
      );
    return Response.json({
      id: `response-${bodies.length}`,
      status: "completed",
      output_text: "OK",
      output: [],
    });
  });
  const options = {
    runtime: {
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      folderId: "folder",
      modelUri: "gpt://folder/model",
    },
    conversationId: "conversation-1",
    input: "Проверка",
    instructions: "Кратко",
    tools: [],
    compactThreshold: 32000,
    automaticTruncation: true,
  };
  assert.equal((await client.respond(options)).compactionAvailable, false);
  assert.equal((await client.respond(options)).compactionAvailable, false);
  assert.equal(bodies.length, 3);
  assert.ok(bodies[0].context_management);
  assert.equal(bodies[1].context_management, undefined);
  assert.equal(bodies[2].context_management, undefined);
  assert.equal(bodies[2].truncation, "auto");
});

test("local chats persist, reuse remote context and recover a missing conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-responses-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  const calls: Array<{ conversation: string; input: unknown }> = [];
  const removed: string[] = [];
  let count = 0;
  let missingOnce = false;
  const fake: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/conversations") && init?.method === "POST")
      return Response.json({ id: `conversation-${++count}` });
    if (path.includes("/conversations/") && init?.method === "DELETE") {
      removed.push(path.split("/").at(-1)!);
      return Response.json({ deleted: true });
    }
    if (!path.endsWith("/responses")) throw new Error(`Unexpected ${path}`);
    const body = JSON.parse(String(init?.body)) as {
      conversation: string;
      input: unknown;
    };
    calls.push(body);
    if (missingOnce && body.conversation === "conversation-1") {
      missingOnce = false;
      return Response.json(
        { error: { message: "Conversation not found" } },
        { status: 404 },
      );
    }
    return Response.json({
      id: `response-${calls.length}`,
      status: "completed",
      output_text: "Здравствуйте!",
      output: [],
      usage: { input_tokens: 10, output_tokens: 3 },
    });
  };
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    fake,
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const send = async (message: string, chatId?: string) => {
    const response = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, ...(chatId ? { chatId } : {}) }),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ chatId: string; answer: string }>;
  };
  try {
    const first = await send("Привет");
    const second = await send("Добрый день", first.chatId);
    assert.equal(second.chatId, first.chatId);
    assert.equal(count, 1);
    assert.equal(calls[0].conversation, "conversation-1");
    assert.equal(calls[1].conversation, "conversation-1");
    assert.deepEqual(calls[1].input, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Добрый день" }],
      },
    ]);
    const detail = await fetch(`${base}/api/ai/chats/${first.chatId}`).then(
      (response) => response.json(),
    );
    assert.equal(detail.messages.length, 4);

    missingOnce = true;
    await send("Продолжим", first.chatId);
    assert.equal(count, 2);
    assert.equal(calls.at(-1)?.conversation, "conversation-2");
    assert.equal((calls.at(-1)?.input as unknown[]).length, 5);

    const independent = await send("Новый разговор");
    assert.notEqual(independent.chatId, first.chatId);
    assert.equal(count, 3);
    const deleted = await fetch(`${base}/api/ai/chats/${first.chatId}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(removed, ["conversation-2"]);
    assert.equal(
      (await fetch(`${base}/api/ai/chats/${first.chatId}`)).status,
      404,
    );
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

test("agent returns multiple call outputs to matching call IDs and serializes one chat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-responses-tools-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  const requests: Array<Record<string, unknown>> = [];
  let releaseHold: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const fake: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/conversations"))
      return Response.json({ id: "conversation-tools" });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (requests.length === 1)
      return Response.json({
        id: "initial",
        status: "completed",
        output_text: "Привет",
        output: [],
      });
    if (requests.length === 2) {
      await hold;
      return Response.json({
        id: "tools",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "first-call",
            name: "get_archive_insights",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: "second-call",
            name: "list_people",
            arguments: "{}",
          },
        ],
      });
    }
    return Response.json({
      id: "final",
      status: "completed",
      output_text: "Проверил архив",
      output: [],
    });
  };
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    fake,
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const send = (message: string, chatId?: string) =>
    fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, ...(chatId ? { chatId } : {}) }),
    });
  try {
    const first = (await (await send("Привет")).json()) as { chatId: string };
    const pending = send("Сколько людей в архиве?", first.chatId);
    for (let attempt = 0; requests.length < 2 && attempt < 50; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requests.length, 2);
    const concurrent = await send("Ещё вопрос", first.chatId);
    assert.equal(concurrent.status, 409);
    releaseHold!();
    assert.equal((await pending).status, 200);
    const outputs = requests[2].input as Array<{
      call_id: string;
      type: string;
      output: string;
    }>;
    assert.deepEqual(
      outputs.map((item) => item.call_id),
      ["first-call", "second-call"],
    );
    assert.ok(outputs.every((item) => item.type === "function_call_output"));
    assert.match(outputs[0].output, /totals/);
  } finally {
    releaseHold?.();
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
