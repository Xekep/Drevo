import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { Family } from "../src/domain/types.ts";
import {
  explicitViewControlRequest,
  humanizeResearchAnswer,
  recoverTextToolCalls,
  requesterAccessContext,
  requesterPromptContext,
} from "../src/server/ai-research-http.ts";

test("research answer keeps clickable markers but replaces raw archive ids", () => {
  const people = new Map([["person-42", "Иван Петрович"]]);
  assert.equal(
    humanizeResearchAnswer(
      "[[person:person-42|Иван Петрович]] найден. person-42 (personId: person-42) упомянут в записи.",
      people,
      new Map(),
    ),
    "[[person:person-42|Иван Петрович]] найден. Иван Петрович упомянут в записи.",
  );
});

test("явные команды перемещают пользователя по древу, обычный вопрос экран не меняет", () => {
  assert.equal(
    explicitViewControlRequest("Покажи Анну на древе", "gallery"),
    true,
  );
  assert.equal(
    explicitViewControlRequest("Перемести меня к Анне", "tree"),
    true,
  );
  assert.equal(
    explicitViewControlRequest("Найди Василия в дереве", "tree"),
    true,
  );
  assert.equal(explicitViewControlRequest("Расскажи об Анне", "tree"), false);
});

test("textual model tool call is recovered instead of being shown as Arduino code", () => {
  assert.deepEqual(
    recoverTextToolCalls(
      '```arduino\nsearch_people({"query":"Татьяна Вьюхина"})\n```',
      new Set(["search_people"]),
    ),
    [
      {
        id: "recovered-tool-0",
        type: "function",
        function: {
          name: "search_people",
          arguments: '{"query":"Татьяна Вьюхина"}',
        },
      },
    ],
  );
  assert.deepEqual(
    recoverTextToolCalls(
      '```arduino\ndelete_everything({"yes":true})\n```',
      new Set(["search_people"]),
    ),
    [],
  );
  assert.deepEqual(
    recoverTextToolCalls(
      'Создаю отчёт:\n```\ncreate_pdf\n{"title":"Семейный архив","content":"Текст"}\n```',
      new Set(["create_pdf"]),
    ).map((call) => [call.function.name, JSON.parse(call.function.arguments)]),
    [["create_pdf", { title: "Семейный архив", content: "Текст" }]],
  );
  assert.deepEqual(
    recoverTextToolCalls(
      "```\nget_archive_insights\n{}\n```",
      new Set(["get_archive_insights"]),
    ).map((call) => call.function.name),
    ["get_archive_insights"],
  );
  const sample = [
    "Вызову данные о её родственниках:",
    '```json\n{"name":"get_family","parameters":{"personId":"person-42"}}\n```',
    "Построю хронологию:",
    '```\n{"name":"get_timeline","parameters":{"personId":"person-42"}}\n```',
  ].join("\n\n");
  assert.deepEqual(
    recoverTextToolCalls(sample, new Set(["get_family", "get_timeline"])),
    [
      {
        id: "recovered-tool-0",
        type: "function",
        function: {
          name: "get_family",
          arguments: '{"personId":"person-42"}',
        },
      },
      {
        id: "recovered-tool-1",
        type: "function",
        function: {
          name: "get_timeline",
          arguments: '{"personId":"person-42"}',
        },
      },
    ],
  );
  assert.deepEqual(
    recoverTextToolCalls(
      sample.replace("get_timeline", "delete_everything"),
      new Set(["get_family", "get_timeline"]),
    ),
    [],
  );
});

test("stream only exposes the checked answer after textual tool calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-safe-stream-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let calls = 0;
  const aiFetch: typeof fetch = async () => {
    calls++;
    const content =
      calls === 1
        ? 'Вызову данные о семье:\n```json\n{"name":"get_family","parameters":{"personId":"person-42"}}\n```\nЗатем хронологию:\n```json\n{"name":"get_timeline","parameters":{"personId":"person-42"}}\n```\nСкоро вернусь!'
        : "[[person:person-42|Иван Петрович]] найден. person-42 (personId: person-42).";
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
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
        people: [
          {
            id: "person-42",
            surname: "Петрович",
            name: "Иван",
            patronymic: "",
            sex: "m",
            birth: "1900",
            birthPlace: "",
            parents: [],
            spouses: [],
            generation: 1,
            column: 0,
            sources: [],
          },
        ],
      },
      current.revision,
    );
    const response = await fetch(base + "/api/ai/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Расскажи об Иване Петровиче" }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("event: "))
      .map((frame) => {
        const [name, data] = frame.split("\ndata: ");
        return { name: name.slice(7), data: JSON.parse(data) };
      });
    const deltas = events.filter((event) => event.name === "delta");
    assert.equal(deltas.length, 1);
    assert.doesNotMatch(
      deltas[0].data.text.replace(/\[\[[^\]]+\]\]/g, ""),
      /get_family|get_timeline|person-42|personId|Скоро вернусь/,
    );
    assert.match(deltas[0].data.text, /Иван Петрович/);
    assert.match(
      events.find((event) => event.name === "done")!.data.answer,
      /\[\[person:person-42\|Иван Петрович\]\]/,
    );
    assert.equal(calls, 2);
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

test("researcher retries an unverified archive answer and executes a textual tool call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-retry-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  const requests: Array<Record<string, unknown>> = [];
  const aiFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (requests.length === 1)
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "В архиве нет данных о Тане Вьюхиной.",
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
              content:
                '```arduino\nsearch_people({"query":"Татьяна Вьюхина"})\n```',
            },
          },
        ],
      });
    if (requests.length === 3)
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "family-call",
                  type: "function",
                  function: {
                    name: "get_family",
                    arguments: '{"personId":"tatyana-retry"}',
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
            content:
              "У [[person:tatyana-retry|Вьюхина Татьяна Ивановна]] есть брат [[person:brother-retry|Вьюхин Пётр Иванович]].",
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
    const current = app.archive.read(),
      parent = {
        id: "parent-retry",
        surname: "Вьюхин",
        name: "Иван",
        patronymic: "",
        sex: "m" as const,
        birth: "1900",
        birthPlace: "",
        parents: [],
        spouses: [],
        generation: 1,
        column: 0,
        sources: [],
      };
    app.archive.write(
      {
        ...current.family,
        people: [
          ...current.family.people,
          parent,
          {
            ...parent,
            id: "tatyana-retry",
            surname: "Вьюхина",
            name: "Татьяна",
            patronymic: "Ивановна",
            sex: "f",
            parents: ["parent-retry"],
          },
          {
            ...parent,
            id: "brother-retry",
            name: "Пётр",
            patronymic: "Иванович",
            parents: ["parent-retry"],
          },
        ],
      },
      current.revision,
    );
    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "У Тани Вьюхиной есть братья?" }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.doesNotMatch(payload.answer, /arduino|search_people/);
    assert.match(payload.answer, /Пётр/);
    assert.equal(requests.length, 4);
    assert.match(
      JSON.stringify(requests[1].messages),
      /Предыдущий ответ не был проверен по архиву/,
    );
    assert.match(JSON.stringify(requests[2].messages), /tatyana-retry/);
    assert.match(JSON.stringify(requests[3].messages), /brother-retry/);
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

test("researcher resolves a short cousin follow-up from conversation history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-cousins-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  const requests: Array<Record<string, unknown>> = [];
  const aiFetch: typeof fetch = async (_url, init) => {
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
                  id: "cousins-call",
                  type: "function",
                  function: {
                    name: "get_cousins",
                    arguments: '{"personId":"tatyana-cousins","degree":2}',
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
            content:
              "У [[person:tatyana-cousins|Вьюхина Татьяна Ивановна]] есть двоюродный брат [[person:vasily-cousins|Скулко Василий Петрович]].",
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
    const current = app.archive.read(),
      makePerson = (
        id: string,
        surname: string,
        name: string,
        sex: "m" | "f",
        parents: string[] = [],
      ) => ({
        id,
        surname,
        name,
        patronymic: sex === "f" ? "Ивановна" : "Петрович",
        sex,
        birth: "1900",
        birthPlace: "",
        parents,
        spouses: [],
        generation: 1,
        column: 0,
        sources: [],
      });
    app.archive.write(
      {
        ...current.family,
        people: [
          makePerson("grandfather-cousins", "Вьюхин", "Иван", "m"),
          makePerson("parent-a-cousins", "Вьюхина", "Анна", "f", [
            "grandfather-cousins",
          ]),
          makePerson("parent-b-cousins", "Скулко", "Пётр", "m", [
            "grandfather-cousins",
          ]),
          makePerson("tatyana-cousins", "Вьюхина", "Татьяна", "f", [
            "parent-a-cousins",
          ]),
          makePerson("vasily-cousins", "Скулко", "Василий", "m", [
            "parent-b-cousins",
          ]),
        ],
      },
      current.revision,
    );
    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "а двоюродные",
        history: [
          { role: "user", content: "Какие родственники есть у Татьяны?" },
          {
            role: "assistant",
            content:
              "У [[person:tatyana-cousins|Вьюхина Татьяна Ивановна]] есть родные сёстры.",
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.match(payload.answer, /Василий/);
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[0].messages), /а двоюродные/);
    assert.match(JSON.stringify(requests[0].messages), /tatyana-cousins/);
    assert.match(JSON.stringify(requests[0].tools), /get_cousins/);
    assert.match(JSON.stringify(requests[1].messages), /vasily-cousins/);
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
        message: "Перемести меня к Анне",
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
    assert.deepEqual(payload.uiActions, [
      { type: "focus_people", personIds: ["anna-ai-test"] },
    ]);
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
    assert.match(
      firstMessages[0].content || "",
      /переместить его к человеку на древе[\s\S]*action=focus_people/,
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
