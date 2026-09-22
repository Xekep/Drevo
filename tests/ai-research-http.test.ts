import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { Family } from "../src/domain/types.ts";
import {
  requesterAccessContext,
  requesterPromptContext,
} from "../src/server/ai-research-http.ts";

test("web researcher uses Yandex AI Studio function calling through server only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";

  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> =
    [];
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
                {
                  id: "call-2",
                  type: "function",
                  function: {
                    name: "get_sources",
                    arguments: JSON.stringify({ personId: "anna-ai-test" }),
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
    "http://127.0.0.1:" + (app.server.address() as { port: number }).port;

  try {
    const current = app.archive.read();
    const family: Family = {
      ...current.family,
      people: [
        ...current.family.people,
        {
          id: "anna-ai-test",
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
          sources: [
            {
              title: "Метрическая запись",
              type: "archive",
              reference: "Ф. 1, оп. 2, д. 3",
              url: "https://archive.example/item/3",
            },
          ],
        },
      ],
    };
    app.archive.write(family, current.revision);
    assert.match(
      requesterPromptContext(
        {
          id: "linked-user",
          name: "Анна",
          role: "relative",
          createdAt: "",
          approved: true,
          personId: "anna-ai-test",
          treeAccess: "all",
        },
        family,
      ),
      /обращается Лебедь Анна Семёновна.*personId: anna-ai-test.*Слова «я»/,
    );
    assert.match(
      requesterAccessContext(
        {
          id: "reader",
          name: "Читатель",
          role: "reader",
          approved: true,
          createdAt: "",
          treeAccess: "common_ancestors",
        },
        false,
      ),
      /только людей из области общих предков.*Доступ только для чтения/,
    );

    const status = await fetch(base + "/api/ai/status").then((response) =>
      response.json(),
    );
    assert.equal(status.enabled, true);

    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Найди Анну",
        context: { view: "tree", personIds: ["anna-ai-test"] },
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.answer, "В архиве найдена Анна Лебедь.");
    assert.deepEqual(
      payload.references.find(
        (reference: { kind: string }) => reference.kind === "person",
      ),
      {
        kind: "person",
        id: "anna-ai-test",
        label: "Лебедь Анна Семёновна",
      },
    );
    assert.deepEqual(
      payload.references.find(
        (reference: { kind: string }) => reference.kind === "source",
      ),
      {
        kind: "source",
        personId: "anna-ai-test",
        label: "Метрическая запись",
        reference: "Ф. 1, оп. 2, д. 3",
        url: "https://archive.example/item/3",
      },
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.get("authorization"), "Api-Key test-key");
    assert.equal(requests[0].headers.get("openai-project"), "folder-1");
    assert.equal(requests[0].body.model, "gpt://folder-1/yandexgpt/rc");
    const firstMessages = requests[0].body.messages as Array<{
      role: string;
      content?: string;
    }>;
    assert.match(
      firstMessages[0].content || "",
      /только если эта связь явно присутствует в photo\.documentedRelationships[\s\S]*Никогда не угадывай родство/,
    );

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

test("web researcher can inspect an authorized archive photo through a bounded preview", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-photo-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "aliceai-llm-flash/latest";
  mkdirSync(join(dir, "uploads"), { recursive: true });
  writeFileSync(
    join(dir, "uploads", "photo-ai.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );

  const requests: Array<Record<string, unknown>> = [];
  const aiFetch: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "gpt://folder-1/qwen3.6-35b-a3b/latest",
            owned_by: "Alibaba",
          },
        ],
      });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (requests.length === 1)
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "photo-call",
                  type: "function",
                  function: {
                    name: "analyze_photo",
                    arguments: JSON.stringify({
                      photoId: "photo-ai",
                      question: "Что видно?",
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    if (requests.length === 2)
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "На изображении виден светлый пиксель.",
            },
          },
        ],
      });
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "[[photo:photo-a|Семейный снимок]]: На фотографии виден светлый пиксель.",
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
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const current = app.archive.read();
    app.archive.write(
      {
        ...current.family,
        photos: [
          {
            id: "photo-ai",
            url: "/media/photo-ai.png",
            title: "Семейный снимок",
            tags: [],
          },
        ],
      },
      current.revision,
    );
    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Покажи и проанализируй семейный снимок",
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(
      payload.answer,
      "[[photo:photo-ai|Семейный снимок]]: На фотографии виден светлый пиксель.",
    );
    assert.deepEqual(payload.uiActions, [
      { type: "open_photo", photoId: "photo-ai" },
    ]);
    assert.equal(requests.length, 3);
    assert.deepEqual(
      payload.references.find(
        (item: { kind: string }) => item.kind === "photo",
      ),
      {
        kind: "photo",
        id: "photo-ai",
        label: "Семейный снимок",
      },
    );
    assert.equal(requests[1].model, "gpt://folder-1/qwen3.6-35b-a3b/latest");
    assert.equal(requests[1].tools, undefined);
    const secondMessages = requests[1].messages as Array<{
      role: string;
      content?: Array<{
        type: string;
        image_url?: { url: string; detail?: string };
      }>;
    }>;
    const imageMessage = secondMessages.find(
      (message) => message.role === "user" && Array.isArray(message.content),
    );
    const image = imageMessage?.content?.find(
      (item) => item.type === "image_url",
    );
    assert.match(image?.image_url?.url || "", /^data:image\/jpeg;base64,/);
    assert.equal(image?.image_url?.detail, undefined);
    const finalMessages = requests[2].messages as Array<{
      role: string;
      content?: string;
    }>;
    assert.match(
      finalMessages.find((message) => message.role === "tool")?.content || "",
      /На изображении виден светлый пиксель/,
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
