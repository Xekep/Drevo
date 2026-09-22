import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { Family } from "../src/domain/types.ts";

test("web researcher uses Yandex AI Studio function calling through server only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";

  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  let call = 0;
  const aiFetch: typeof fetch = async (_url, init) => {
    requests.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    call++;
    if (call === 1)
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "search_people",
                    arguments: JSON.stringify({ query: "Анна" }),
                  },
                },
              ],
            },
          },
        ],
      });
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: "В архиве найдена Анна Лебедь.",
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
  );
  const base =
    "http://127.0.0.1:" +
    (app.server.address() as { port: number }).port;

  try {
    const current = app.archive.read();
    const family: Family = {
      ...current.family,
      people: [
        {
          id: "anna",
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
    app.archive.write(family, current.revision);

    const status = await fetch(base + "/api/ai/status").then((response) =>
      response.json(),
    );
    assert.equal(status.enabled, true);

    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Найди Анну",
        context: { view: "tree", personIds: ["anna"] },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).answer,
      "В архиве найдена Анна Лебедь.",
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.get("authorization"), "Api-Key test-key");
    assert.equal(requests[0].headers.get("openai-project"), "folder-1");
    assert.equal(requests[0].body.model, "gpt://folder-1/yandexgpt/rc");

    const secondMessages = requests[1].body.messages as Array<{
      role: string;
      content?: string;
    }>;
    const toolMessage = secondMessages.find(
      (message) => message.role === "tool",
    );
    assert.match(toolMessage?.content || "", /Анна/);
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
