import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { adaptLegacyAiFake } from "./legacy-ai-fake.ts";
import type { Family } from "../src/domain/types.ts";

function providerStream(frames: unknown[]) {
  const body =
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("AI research stream preserves tool calling and emits the checked answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-stream-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";

  const requests: Array<Record<string, unknown>> = [];
  let call = 0;
  const aiFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    assert.equal(body.stream, true);
    call++;

    if (call === 1)
      return providerStream([
        {
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-stream-1",
                    type: "function",
                    function: {
                      name: "search_people",
                      arguments: '{"query":"',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: 'Анна"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);

    return providerStream([
      {
        choices: [
          {
            delta: { role: "assistant", content: "Найдена " },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { content: "Анна." },
            finish_reason: "stop",
          },
        ],
      },
    ]);
  };

  const app = await startServer(
      0,
      join(dir, "drevo.sqlite"),
      true,
      undefined,
      adaptLegacyAiFake(aiFetch),
    ),
    base =
      "http://127.0.0.1:" + (app.server.address() as { port: number }).port;

  try {
    const current = await app.archive.read(),
      family: Family = {
        ...current.family,
        people: [
          ...current.family.people,
          {
            id: "anna-stream-test",
            surname: "Лебедь",
            name: "Анна",
            patronymic: "Семёновна",
            sex: "f",
            birth: "1919",
            birthPlace: "Нижнее",
            parents: [],
            spouses: [],
            generation: 1,
            column: 0,
            sources: [],
          },
        ],
      };
    await app.archive.write(family, current.revision);

    const response = await fetch(base + "/api/ai/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Найди Анну",
        context: { view: "tree", personIds: ["anna-stream-test"] },
      }),
    });
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") || "",
      /text\/event-stream/,
    );

    const stream = await response.text();
    assert.match(stream, /event: status/);
    assert.match(stream, /Ищу людей в архиве/);
    assert.doesNotMatch(stream, /event: delta/);
    assert.match(stream, /event: done/);
    assert.match(stream, /"answer":"Найдена Анна\."/);
    assert.match(stream, /"id":"anna-stream-test"/);
    assert.match(stream, /"label":"Лебедь Анна Семёновна"/);

    assert.equal(requests.length, 2);
    const secondMessages = requests[1].messages as Array<{
      role: string;
      content?: string;
      tool_call_id?: string;
    }>;
    const toolMessage = secondMessages.find(
      (message) => message.role === "tool",
    );
    assert.equal(toolMessage?.tool_call_id, "call-stream-1");
    assert.match(toolMessage?.content || "", /anna-stream-test/);
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
