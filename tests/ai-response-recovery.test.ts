import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { aiChatStore } from "../src/server/ai-chats.ts";
import {
  yandexResponsesClient,
  YandexResponseError,
} from "../src/server/yandex-responses.ts";

const options = {
  runtime: {
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    folderId: "folder",
    modelUri: "gpt://folder/qwen3.6-35b-a3b/latest",
  },
  conversationId: "conversation",
  input: "Проверь архив",
  instructions: "Проверь инструментами",
  tools: [],
  compactThreshold: null,
  automaticTruncation: true,
  stream: true,
};

test("completed SSE is terminal even when upstream never closes or finishes cancellation", async () => {
  let cancelled = false;
  const client = yandexResponsesClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.reasoning, undefined);
    assert.equal(body.max_output_tokens, 8000);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.completed","response":{"id":"done","status":"completed","output_text":"Готово"}}\n\n',
            ),
          );
        },
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      client.respond(options),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("waited for socket EOF")),
          200,
        );
      }),
    ]);
    assert.equal(result.text, "Готово");
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timer);
  }
});

test("incomplete SSE reports the real terminal cause and response ID", async () => {
  const client = yandexResponsesClient(
    async () =>
      new Response(
        'data: {"type":"response.incomplete","response":{"id":"limited","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
      ),
  );
  await assert.rejects(
    client.respond(options),
    (error: unknown) =>
      error instanceof YandexResponseError &&
      error.code === "incomplete_max_output_tokens" &&
      error.responseId === "limited",
  );
});

test("provider authorization errors identify endpoint without exposing credentials", async () => {
  const client = yandexResponsesClient(async () =>
    Response.json({ error: { message: "Denied" } }, { status: 403 }),
  );
  await assert.rejects(
    client.createConversation(options.runtime),
    (error: unknown) =>
      error instanceof YandexResponseError &&
      error.endpoint === "/conversations" &&
      error.status === 403,
  );
});

for (const failure of [
  "timeout",
  "broken-stream",
  "forbidden",
  "retry-fails",
  "token-limit",
  "token-limit-retry-fails",
] as const)
  test(`agent ${failure}: bounded recovery preserves history without duplicate input`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "drevo-ai-recovery-"));
    const keys = [
      "YANDEX_AI_API_KEY",
      "YANDEX_AI_FOLDER_ID",
      "YANDEX_AI_MODEL",
    ];
    const previous = keys.map((key) => process.env[key]);
    Object.assign(process.env, {
      YANDEX_AI_API_KEY: "test-key",
      YANDEX_AI_FOLDER_ID: "folder",
      YANDEX_AI_MODEL: "qwen3.6-35b-a3b/latest",
    });
    const requests: Array<Record<string, unknown>> = [];
    let conversations = 0;
    const fake: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/conversations"))
        return Response.json({ id: `conv-${++conversations}` });
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (requests.length === 1)
        return Response.json({
          id: "first",
          status: "completed",
          output_text: "Уточните архив",
        });
      if (
        requests.length === 2 ||
        (["retry-fails", "token-limit-retry-fails"].includes(failure) &&
          requests.length === 3)
      ) {
        if (failure.startsWith("token-limit")) {
          const limited = {
            id: "limited",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          };
          return body.stream
            ? new Response(
                `data: ${JSON.stringify({ type: "response.incomplete", response: limited })}\n\n`,
              )
            : Response.json(limited);
        }
        if (failure === "forbidden")
          return Response.json(
            { error: { message: "private provider diagnostic" } },
            { status: 403 },
          );
        if (failure === "broken-stream")
          return new Response(
            'data: {"type":"response.created","response":{"id":"lost","status":"in_progress"}}\n\n',
          );
        throw new DOMException("Provider timed out", "TimeoutError");
      }
      return Response.json({
        id: "recovered",
        status: "completed",
        output_text: "Сохранил контекст: ГАСО, фонд 6, опись 13, дело 104.",
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
    try {
      const first = await fetch(base + "/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Ф.6, Оп.13, Д.104" }),
      }).then((res) => res.json());
      if (failure === "timeout") {
        const chats = aiChatStore(app.archive.db);
        for (let index = 0; index < 12; index++)
          await chats.append(first.chatId, "user", "ку");
      }
      const response = await fetch(base + "/api/ai/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: first.chatId,
          message: "да ищи в гасо",
        }),
      });
      const text = await response.text();
      if (failure === "forbidden") {
        assert.equal(conversations, 1);
        assert.equal(requests.length, 2);
        assert.match(text, /Yandex AI отклонил доступ/);
        assert.doesNotMatch(text, /private provider diagnostic/);
      } else {
        assert.equal(conversations, 2);
        assert.equal(requests.length, 3);
        assert.equal(requests[2].conversation, "conv-2");
        assert.equal(requests[2].stream, undefined);
        if (failure.startsWith("token-limit"))
          assert.equal(requests[2].max_output_tokens, 16000);
        const input = JSON.stringify(requests[2].input);
        assert.match(input, /Ф\.6, Оп\.13, Д\.104/);
        assert.match(input, /Уточните архив/);
        assert.equal((input.match(/да ищи в гасо/g) || []).length, 1);
        assert.match(
          text,
          failure.endsWith("retry-fails") ? /event: error/ : /event: done/,
        );
        if (failure === "token-limit-retry-fails")
          assert.match(text, /исчерпал лимит/);
      }
      const chat = await fetch(base + `/api/ai/chats/${first.chatId}`).then(
        (res) => res.json(),
      );
      assert.equal(
        chat.messages.filter((item: { role: string }) => item.role === "user")
          .length,
        failure === "timeout" ? 14 : 2,
      );
      if (failure === "forbidden" || failure.endsWith("retry-fails")) {
        assert.doesNotMatch(JSON.stringify(chat.messages), /Служебный статус/);
        const followup = await fetch(base + "/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: first.chatId,
            message: "Почему ответ оборвался?",
          }),
        });
        assert.equal(followup.status, 200);
        const restored = JSON.stringify(requests.at(-1)?.input);
        assert.match(restored, /Служебный статус предыдущего ответа/);
        assert.doesNotMatch(restored, /private provider diagnostic|test-key/);
      }
    } finally {
      await app.close();
      keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key];
        else process.env[key] = previous[i];
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });

for (const failure of [
  "timeout",
  "token-limit",
  "repeated-tool",
  "empty-recovery",
] as const)
  test(`after-tool ${failure}: recovery synthesizes results and never replays tools`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "drevo-ai-after-tool-"));
    const env = {
      YANDEX_AI_API_KEY: "test-key",
      YANDEX_AI_FOLDER_ID: "folder",
      YANDEX_AI_MODEL: "model",
    };
    const previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    let conversations = 0,
      calls = 0;
    const fake: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/conversations")) {
        conversations++;
        return Response.json({ id: "conv" });
      }
      calls++;
      if (calls === 1)
        return Response.json({
          id: "tools",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "lookup",
              name: "get_archive_insights",
              arguments: "{}",
            },
          ],
        });
      const body = JSON.parse(String(init?.body));
      if (calls === 3) {
        assert.deepEqual(body.tools, []);
        assert.equal(body.tool_choice, "none");
        assert.match(JSON.stringify(body.input), /get_archive_insights/);
        assert.match(JSON.stringify(body.input), /completeness/);
        if (failure === "token-limit")
          assert.equal(body.max_output_tokens, 16000);
        if (failure === "repeated-tool")
          return Response.json({
            id: "ignored-disabled-tools",
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "again",
                name: "get_archive_insights",
                arguments: "{}",
              },
            ],
          });
        return Response.json({
          id: "recovered",
          status: "completed",
          output_text:
            failure === "empty-recovery"
              ? ""
              : "Обзор составлен по сохранённым данным.",
        });
      }
      assert.equal(body.input[0].call_id, "lookup");
      if (failure === "token-limit")
        return Response.json({
          id: "limited",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        });
      throw new DOMException("Provider timed out", "TimeoutError");
    };
    const app = await startServer(
      0,
      join(dir, "drevo.sqlite"),
      true,
      undefined,
      fake,
    );
    try {
      const result = await fetch(
        `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/ai/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Посчитай людей в архиве" }),
        },
      );
      assert.equal(result.status, failure === "repeated-tool" ? 502 : 200);
      assert.equal(conversations, 2);
      assert.equal(calls, 3);
      const payload = await result.json();
      if (failure === "repeated-tool")
        assert.match(payload.error, /Повторные действия не выполнялись/);
      else
        assert.match(
          payload.answer,
          failure === "empty-recovery"
            ? /Не удалось завершить ответ/
            : /сохранённым данным/,
        );
    } finally {
      await app.close();
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

for (const exhausted of [false, true])
  test(`external search budget retains sources (agent exhausted: ${exhausted})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "drevo-ai-search-budget-"));
    const env = {
      YANDEX_AI_API_KEY: "test-key",
      YANDEX_AI_FOLDER_ID: "folder",
      YANDEX_AI_MODEL: "model",
      AI_WEB_SEARCH_ENABLED: "true",
      AI_WEB_SEARCH_PROVIDER: "yandex",
    };
    const previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    let agentCalls = 0,
      searchCalls = 0;
    const fake: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/conversations"))
        return Response.json({ id: "conv" });
      const body = JSON.parse(String(init?.body));
      if (
        body.tools.some((tool: { type: string }) => tool.type === "web_search")
      ) {
        searchCalls++;
        return Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Найден каталог; дело не проверено",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://archive.example.org/catalog",
                      title: "Каталог",
                    },
                  ],
                },
              ],
            },
          ],
        });
      }
      agentCalls++;
      if (agentCalls === 9) {
        assert.deepEqual(body.tools, []);
        assert.equal(body.tool_choice, "none");
      }
      if (agentCalls >= 4)
        assert.equal(
          body.tools.some(
            (tool: { name: string }) => tool.name === "web_search",
          ),
          false,
        );
      return Response.json({
        id: `round-${agentCalls}`,
        status: "completed",
        ...(exhausted || agentCalls <= 4
          ? {
              output: [
                {
                  type: "function_call",
                  call_id: `search-${agentCalls}`,
                  name: "web_search",
                  arguments: JSON.stringify({
                    query: `ГАСО дело ${agentCalls}`,
                    scope: "global",
                  }),
                },
              ],
            }
          : {
              output_text:
                "[Каталог](https://archive.example.org/catalog). Точная запись пока не подтверждена.",
            }),
      });
    };
    const app = await startServer(
      0,
      join(dir, "drevo.sqlite"),
      true,
      undefined,
      fake,
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/ai/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Ищи в ГАСО дело 104" }),
        },
      );
      assert.equal(response.status, 200);
      assert.equal(searchCalls, 3);
      assert.equal(agentCalls, exhausted ? 9 : 5);
      const result = await response.json();
      assert.match(result.answer, /https:\/\/archive\.example\.org\/catalog/);
      if (exhausted)
        assert.match(result.answer, /точный ответ пока не подтверждён/);
    } finally {
      await app.close();
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("only the Qwen search summarizer disables reasoning; other models retain provider defaults", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client = yandexResponsesClient(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ status: "completed", output: [] });
  });
  await client.webSearch({
    runtime: options.runtime,
    query: "ГАСО",
    signal: new AbortController().signal,
  });
  await client.webSearch({
    runtime: { ...options.runtime, modelUri: "gpt://folder/other-model" },
    query: "ГАСО",
    signal: new AbortController().signal,
  });
  assert.deepEqual(requests[0].reasoning, { effort: "none" });
  assert.equal(requests[1].reasoning, undefined);
});
