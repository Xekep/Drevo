import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

for (const streaming of [false, true])
  for (const citationMode of ["cited", "retry", "fallback"] as const)
    test(`web search agent ${streaming ? "SSE" : "HTTP"} ${citationMode} retains citations and isolates credentials`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "drevo-web-search-"));
      const env = {
        YANDEX_AI_API_KEY: "private-web-search-test-key",
        YANDEX_AI_FOLDER_ID: "folder-1",
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
          return Response.json({ id: "conv-test" });
        const body = JSON.parse(String(init?.body));
        if (
          body.tools?.some(
            (tool: { type: string }) => tool.type === "web_search",
          )
        ) {
          searchCalls++;
          assert.deepEqual(body.tools[0].filters.allowed_domains, [
            "pamyat-naroda.ru",
            "obd-memorial.ru",
            "podvignaroda.ru",
            "rgvarchive.ru",
            "gwar.mil.ru",
          ]);
          assert.equal(
            body.conversation,
            undefined,
            "search request does not send archive conversation",
          );
          return Response.json({
            id: "web-response",
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Найдена возможная запись. Нужна сверка имени и года.",
                    annotations: [
                      {
                        type: "url_citation",
                        url: "https://pamyat-naroda.ru/heroes/test-record",
                        title: "Возможная запись",
                      },
                    ],
                  },
                ],
              },
            ],
            usage: { input_tokens: 25, output_tokens: 15 },
          });
        }
        agentCalls++;
        assert.ok(
          body.tools.some(
            (tool: { name: string }) => tool.name === "web_search",
          ),
        );
        const output =
          agentCalls === 1
            ? [
                {
                  type: "function_call",
                  call_id: "web-call",
                  name: "web_search",
                  arguments: JSON.stringify({
                    query: "Чепчугов Павел 1908 плен",
                    categories: ["military", "ww2"],
                  }),
                },
              ]
            : [
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      text:
                        citationMode === "fallback" ||
                        (citationMode === "retry" && agentCalls === 2)
                          ? "Этот фонд содержит только документы органов госбезопасности."
                          : "Найдена [возможная запись](https://pamyat-naroda.ru/heroes/test-record). Требуется проверка.",
                    },
                  ],
                },
              ];
        if (agentCalls === 2) {
          const result = JSON.parse(
            body.input.find(
              (item: { type: string }) => item.type === "function_call_output",
            ).output,
          );
          assert.equal(result.scope, "trusted");
          assert.equal(result.results[0].sourceName, "Память народа");
          assert.equal(result.results[0].snippetKind, "unavailable");
          assert.ok(!JSON.stringify(result).includes(env.YANDEX_AI_API_KEY));
        }
        if (agentCalls === 3)
          assert.match(
            JSON.stringify(body.input),
            /полным названием архива, регионом и шифром/,
          );
        const response = {
          id: `response-${agentCalls}`,
          status: "completed",
          output,
          usage: { input_tokens: 5, output_tokens: 5 },
        };
        return body.stream
          ? new Response(
              `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
              { headers: { "Content-Type": "text/event-stream" } },
            )
          : Response.json(response);
      };
      const app = await startServer(
        0,
        join(dir, "archive.sqlite"),
        true,
        undefined,
        fake,
      );
      try {
        const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
        const response = await fetch(
          base + (streaming ? "/api/ai/chat/stream" : "/api/ai/chat"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "Поищи внешние сведения об участнике войны",
              allowedDomains: ["evil.org"],
            }),
          },
        );
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.ok(!text.includes(env.YANDEX_AI_API_KEY));
        const data = streaming
          ? JSON.parse(
              text
                .split("\n\n")
                .find((frame) => frame.startsWith("event: done"))!
                .split("\ndata: ")[1],
            )
          : JSON.parse(text);
        assert.equal(
          data.references.find(
            (reference: { kind: string }) => reference.kind === "web",
          ).url,
          "https://pamyat-naroda.ru/heroes/test-record",
        );
        assert.equal(searchCalls, 1);
        assert.equal(agentCalls, citationMode === "cited" ? 2 : 3);
        assert.doesNotMatch(
          data.answer,
          /только документы органов госбезопасности/,
        );
        if (citationMode === "fallback")
          assert.match(data.answer, /Не удалось подтвердить ответ источниками/);
        if (streaming) assert.match(text, /Поиск по 5 доверенным доменам/);
        const stored = app.archive.db
          .prepare(
            "SELECT data FROM ai_chat_messages WHERE role='assistant' ORDER BY id DESC LIMIT 1",
          )
          .get();
        assert.match(String(stored?.data), /pamyat-naroda/);
        assert.ok(!String(stored?.data).includes(env.YANDEX_AI_API_KEY));
      } finally {
        await app.close();
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
