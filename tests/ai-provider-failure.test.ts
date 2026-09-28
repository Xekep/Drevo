import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

for (const failStream of [false, true])
  test(`incomplete external search ${failStream ? "and provider stream error" : "has an honest final answer"}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "drevo-provider-failure-"));
    const env = {
      YANDEX_AI_API_KEY: "test-private-key",
      YANDEX_AI_FOLDER_ID: "folder",
      YANDEX_AI_MODEL: "model",
      AI_WEB_SEARCH_ENABLED: "true",
    };
    const previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    let calls = 0,
      cancelled = false;
    let enter = () => {},
      release = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/conversations"))
        return Response.json({ id: "remote" });
      const body = JSON.parse(String(init?.body));
      if (
        body.tools.some((tool: { type: string }) => tool.type === "web_search")
      )
        return Response.json({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
          usage: { input_tokens: 10, output_tokens: 2000 },
        });
      calls++;
      if (calls === 2) {
        const result = JSON.parse(body.input[0].output);
        assert.equal(result.error, "WEB_SEARCH_INCOMPLETE");
        assert.match(result.notice, /не означает, что запись отсутствует/);
        if (failStream) {
          enter();
          await hold;
          return new Response(
            new ReadableStream({
              start(controller) {
                const frames = [
                  {
                    type: "response.created",
                    response: { id: "failed-response" },
                  },
                  {
                    type: "error",
                    error: {
                      code: "upstream_error",
                      message: "Error in input stream " + env.YANDEX_AI_API_KEY,
                    },
                  },
                ];
                controller.enqueue(
                  new TextEncoder().encode(
                    frames
                      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
                      .join(""),
                  ),
                );
                // Deliberately left open: the client must cancel after the error.
              },
              cancel() {
                cancelled = true;
              },
            }),
          );
        }
      }
      const response = {
        id: `response-${calls}`,
        status: "completed",
        output:
          calls === 1
            ? [
                {
                  type: "function_call",
                  call_id: "search-call",
                  name: "web_search",
                  arguments: JSON.stringify({
                    query: "ГАСО Ф.6 Оп.13 Д.104",
                    categories: ["archives"],
                  }),
                },
              ]
            : [],
        output_text: calls === 1 ? "" : "В архиве точно нет такого документа.",
      };
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
      );
    };
    const app = await startServer(
      0,
      join(dir, "archive.sqlite"),
      true,
      undefined,
      fake,
    );
    try {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      const response = await fetch(base + "/api/ai/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "да ищи в гасо" }),
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      if (failStream) {
        await entered;
        t.mock.timers.tick(20_000);
        while (!text.includes(": keep-alive")) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          text += decoder.decode(chunk.value, { stream: true });
        }
        release();
      }
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      reader.releaseLock();
      assert.doesNotMatch(
        text,
        /Error in input stream|test-private-key|WEB_SEARCH_INCOMPLETE/,
      );
      assert.equal(
        calls,
        2,
        "do not replay tool outputs or duplicate the turn on upstream failure",
      );
      const frame = text
        .split("\n\n")
        .find((frame) => frame.startsWith("event: chat"))!;
      const id = JSON.parse(frame.split("\ndata: ")[1]).chatId;
      const detail = await fetch(base + "/api/ai/chats/" + id).then((r) =>
        r.json(),
      );
      assert.equal(detail.chat.busy, false);
      if (failStream) {
        assert.match(text, /event: error/);
        assert.match(text, /Сервис ИИ не смог завершить ответ/);
        assert.equal(cancelled, true);
        assert.equal(
          detail.messages.length,
          1,
          "failed output is not saved as a successful answer",
        );
      } else {
        assert.match(text, /event: done/);
        assert.match(text, /наличие записи пока не проверено/);
        assert.doesNotMatch(text, /В архиве точно нет такого документа/);
        assert.equal(detail.messages.length, 2);
      }
    } finally {
      release();
      t.mock.timers.reset();
      await app.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
