import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { startServer } from "../src/server/index.ts";
import { adaptLegacyAiFake } from "./legacy-ai-fake.ts";
import type { Family } from "../src/domain/types.ts";
import { linkResearchReferences } from "../src/domain/research-answer.ts";
import {
  explicitViewControlRequest,
  humanizeResearchAnswer,
  recoverTextToolCalls,
  requesterAccessContext,
  requesterPromptContext,
  shortTreeZoomRequest,
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

test("raw photo IDs become a clickable photo instead of a service identifier", () => {
  const id = "d6688201-4f30-47a2-a99b-39d0bb5ec2cf";
  const answer = humanizeResearchAnswer(
    `Самая большая фотография — это фотография с идентификатором Фотография ${id}.`,
    new Map(),
    new Map([[id, "Фотография"]]),
  );
  assert.equal(
    answer,
    `Самая большая фотография — это [[photo:${id}|Фотография]].`,
  );
  assert.equal(
    linkResearchReferences(answer),
    `Самая большая фотография — это [Фотография](#drevo-photo-${id}).`,
  );
});

test("internal kinship classification is explained without exposing its code", () => {
  const text = humanizeResearchAnswer(
    "Тип: `half_or_unknown`.",
    new Map(),
    new Map(),
  );
  assert.doesNotMatch(text, /half_or_unknown/);
  assert.match(text, /один общий известный родитель/);
});

test("a reader's edit request returns permissions without a model call or data changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-reader-ai-"));
  const keys = [
    "PUBLIC_ORIGIN",
    "YANDEX_AI_API_KEY",
    "YANDEX_AI_FOLDER_ID",
    "YANDEX_AI_MODEL",
  ];
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, {
    PUBLIC_ORIGIN: "http://localhost",
    YANDEX_AI_API_KEY: "test-key",
    YANDEX_AI_FOLDER_ID: "folder-1",
    YANDEX_AI_MODEL: "yandexgpt/rc",
  });
  let calls = 0;
  const app = await startServer(
    0,
    join(dir, "archive.sqlite"),
    true,
    undefined,
    async () => {
      calls++;
      throw new Error("Reader mutation should not invoke the model");
    },
  );
  try {
    await app.archive.db
      .prepare(
        "INSERT INTO users(id,name,role,approved) VALUES('reader','Читатель','reader',1)",
      )
      .run();
    const token = randomBytes(32).toString("hex");
    await app.archive.db
      .prepare(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      )
      .run(
        createHash("sha256").update(token).digest("hex"),
        "reader",
        Date.now() + 60000,
      );
    const before = await app.archive.read();
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const response = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        Cookie: `drevo_session=${token}`,
      },
      body: JSON.stringify({
        message: "Измени Анне Тестовой год рождения на 1961",
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.match(result.answer, /доступ только для чтения/);
    assert.deepEqual(result.suggestionIds, []);
    assert.equal(calls, 0);
    assert.deepEqual(await app.archive.read(), before);
    const privateExport = await fetch(
      `${base}/api/ai/export/gedcom?format=gedcom7`,
    );
    assert.equal(privateExport.status, 401);
    const gedcom = await fetch(`${base}/api/ai/export/gedcom?format=gedcom7`, {
      headers: { Cookie: `drevo_session=${token}` },
    });
    assert.equal(gedcom.status, 200);
    assert.match(
      gedcom.headers.get("content-disposition") || "",
      /drevo-7\.ged/,
    );
    assert.match(await gedcom.text(), /GEDC/);
    const invalidPerson = await fetch(
      `${base}/api/ai/export/lineage?personId=unknown&direction=ancestors`,
      {
        headers: { Cookie: `drevo_session=${token}` },
      },
    );
    assert.equal(invalidPerson.status, 404);
    const exportChat = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        Cookie: `drevo_session=${token}`,
      },
      body: JSON.stringify({ message: "Сделай экспорт" }),
    });
    assert.equal(exportChat.status, 200);
    const exportResult = await exportChat.json();
    assert.ok(
      exportResult.files.some(
        (file: { url: string }) =>
          file.url === "/api/ai/export/gedcom?format=gedcom7",
      ),
    );
    assert.equal(calls, 0);
  } finally {
    await app.close();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.equal(
    explicitViewControlRequest(
      "Покажи диаграмму количества людей по годам",
      "tree",
    ),
    false,
  );
  assert.equal(
    explicitViewControlRequest(
      "Покажи граф родства между мной и Варварой",
      "tree",
    ),
    false,
  );
  assert.equal(
    explicitViewControlRequest(
      "отобрази на древе чепчуговых только и их предков ближайших",
      "tree",
    ),
    true,
  );
});

test("короткая команда приближения действует только в древе", () => {
  assert.equal(shortTreeZoomRequest("так ты приблизь", "tree"), "zoom_in");
  assert.equal(shortTreeZoomRequest("отдали ещё", "tree"), "zoom_out");
  assert.equal(shortTreeZoomRequest("так ты приблизь", "gallery"), null);
  assert.equal(shortTreeZoomRequest("приблизь Анну", "tree"), null);
});

test("surname-only tree request builds a verified temporary subset without a model call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-subtree-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let providerCalls = 0;
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    adaptLegacyAiFake(async () => {
      providerCalls++;
      throw new Error(
        "Explicit surname filtering should not require a model call",
      );
    }),
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const current = await app.archive.read();
    const template = {
      surname: "Чепчугов",
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
    await app.archive.write(
      {
        ...current.family,
        people: [
          ...current.family.people,
          {
            ...template,
            id: "chepchugov-father",
            surname: "Чепчугов",
            name: "Иван",
            parents: [],
            spouses: [],
          },
          {
            ...template,
            id: "chepchugov-daughter",
            surname: "Чепчугова",
            name: "Анна",
            parents: ["chepchugov-father"],
            spouses: [],
          },
        ],
      },
      current.revision,
    );
    const response = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "покажи в древе чепчуговых только",
        context: { view: "tree" },
      }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(providerCalls, 0);
    assert.equal(data.uiActions[0].type, "filter_people");
    assert.deepEqual(
      new Set(data.uiActions[0].personIds),
      new Set(["chepchugov-father", "chepchugov-daughter"]),
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

test("explicit review hide request returns a scoped tree action without a model call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-review-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let providerCalls = 0;
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    adaptLegacyAiFake(async () => {
      providerCalls++;
      throw new Error("Review filtering should not require a model call");
    }),
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const current = await app.archive.read();
    await app.archive.write(
      {
        ...current.family,
        people: [
          ...current.family.people,
          {
            id: "needs-review-test",
            surname: "Иванов",
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
            needsReview: true,
          },
        ],
      },
      current.revision,
    );
    const response = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Скрой карточки, требующие проверки, из древа",
        context: { view: "tree" },
      }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(providerCalls, 0);
    assert.deepEqual(data.uiActions, [{ type: "hide_review_people" }]);
    assert.match(data.answer, /Скрыл на древе 1 карточку/);
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

test("stream only exposes the checked answer after textual tool calls and the final access check", async () => {
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
      adaptLegacyAiFake(aiFetch),
    ),
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const current = await app.archive.read();
    await app.archive.write(
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
    assert.equal(events.filter((event) => event.name === "delta").length, 0);
    assert.match(
      events.find((event) => event.name === "done")!.data.answer,
      /\[\[person:person-42\|Иван Петрович\]\]/,
    );
    assert.doesNotMatch(
      events.find((event) => event.name === "done")!.data.answer,
      /get_family|get_timeline|personId|Скоро вернусь/,
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

test("a completed reasoning-only response is retried before the chat returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-empty-response-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let calls = 0;
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    adaptLegacyAiFake(async () => {
      const content =
        ++calls === 1 ? "" : "Здравствуйте! Чем помочь с семейным архивом?";
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }),
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const response = await fetch(base + "/api/ai/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Привет" }),
    });
    const done = (await response.text())
      .split("\n\n")
      .find((frame) => frame.startsWith("event: done\n"));
    assert.ok(done);
    assert.match(JSON.parse(done.split("\ndata: ")[1]).answer, /Здравствуйте/);
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

test("an incomplete provider stream retries once with a non-stream response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-incomplete-stream-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  const requests: boolean[] = [];
  const provider: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations"))
      return Response.json({ id: "conversation-1" });
    const body = JSON.parse(String(init?.body));
    requests.push(Boolean(body.stream));
    return body.stream
      ? new Response("data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        })
      : Response.json({
          id: "response-2",
          status: "completed",
          output_text: "Ответ восстановлен",
          output: [],
        });
  };
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    provider,
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const response = await fetch(base + "/api/ai/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Привет" }),
    });
    const done = (await response.text())
      .split("\n\n")
      .find((frame) => frame.startsWith("event: done\n"));
    assert.ok(done);
    assert.match(
      JSON.parse(done.split("\ndata: ")[1]).answer,
      /Ответ восстановлен/,
    );
    assert.deepEqual(requests, [true, false]);
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

test("a read-only photo question does not offer archive mutation tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-readonly-question-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let offered: string[] = [];
  const provider: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations"))
      return Response.json({ id: "conversation-1" });
    const body = JSON.parse(String(init?.body)) as {
      tools: Array<{ name: string }>;
    };
    offered = body.tools.map((tool) => tool.name);
    return Response.json({
      id: "response-1",
      status: "completed",
      output_text: "Снимки перечислены.",
      output: [],
    });
  };
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    provider,
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Какая фотография с наибольшим числом людей?",
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(offered.includes("search_photos"));
    assert.equal(
      offered.some((name) => name.startsWith("propose_")),
      false,
    );
    assert.equal(offered.includes("create_pdf"), false);
    assert.equal(offered.includes("control_archive_view"), false);
    assert.equal(offered.includes("analyze_photo"), false);
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

test("showing a found photo finishes from the verified search without another model round", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-show-photo-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let calls = 0;
  const provider: typeof fetch = async (url) => {
    if (String(url).endsWith("/conversations"))
      return Response.json({ id: "conversation-1" });
    const call =
      ++calls === 1
        ? { name: "search_people", arguments: '{"query":"Анна"}' }
        : { name: "search_photos", arguments: '{"personId":"anna"}' };
    return Response.json({
      id: `response-${calls}`,
      status: "completed",
      output: [{ type: "function_call", call_id: `call-${calls}`, ...call }],
    });
  };
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    provider,
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const current = await app.archive.read();
    await app.archive.write(
      {
        ...current.family,
        people: [
          {
            id: "anna",
            surname: "Лебедь",
            name: "Анна",
            patronymic: "",
            sex: "f",
            birth: "1919",
            birthPlace: "",
            parents: [],
            spouses: [],
            generation: 1,
            column: 0,
            sources: [],
          },
        ],
        photos: [
          {
            id: "photo-anna",
            title: "Анна у дома",
            url: "/media/photo-anna.jpg",
            tags: [
              {
                id: "tag-anna",
                personId: "anna",
                x: 0,
                y: 0,
                width: 0.2,
                height: 0.2,
              },
            ],
          },
        ],
      },
      current.revision,
    );
    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Покажи фото Анны" }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.match(result.answer, /\[\[photo:photo-anna\|Анна у дома\]\]/);
    assert.deepEqual(result.uiActions, [
      { type: "open_photo", photoId: "photo-anna" },
    ]);
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

test("listing cousins finishes from the kinship tool without a final model call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-cousins-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let calls = 0;
  let conversations = 0;
  let followupInput: unknown;
  const provider: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations"))
      return Response.json({ id: `conversation-${++conversations}` });
    calls++;
    if (calls > 1) {
      if (calls === 2) followupInput = JSON.parse(String(init?.body)).input;
      return Response.json({
        id: "response-2",
        status: "completed",
        output_text: "Продолжение диалога доступно.",
        output: [],
      });
    }
    return Response.json({
      id: "response-1",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "get_cousins",
          arguments: '{"personId":"anna","degree":2}',
        },
      ],
    });
  };
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    provider,
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const member = (
    id: string,
    name: string,
    birth: string,
    parents: string[] = [],
  ) => ({
    id,
    surname: "Лебедь",
    name,
    patronymic: "",
    sex: "u" as const,
    birth,
    birthPlace: "",
    parents,
    spouses: [],
    generation: 1,
    column: 0,
    sources: [],
  });
  try {
    const current = await app.archive.read();
    await app.archive.write(
      {
        ...current.family,
        people: [
          member("grandmother", "Мария", "1930"),
          member("mother", "Ирина", "1950", ["grandmother"]),
          member("uncle", "Иван", "1952", ["grandmother"]),
          member("anna", "Анна", "1980", ["mother"]),
          member("boris", "Борис", "1982", ["uncle"]),
        ],
      },
      current.revision,
    );
    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Кто двоюродные братья и сёстры Анны?" }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.match(result.answer, /\[\[person:boris\|Лебедь Борис\]\]/);
    assert.match(result.answer, /двоюродный брат/);
    const continued = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: result.chatId, message: "Спасибо" }),
    });
    assert.equal(continued.status, 200);
    assert.equal(calls, 2);
    assert.equal(conversations, 2);
    assert.match(JSON.stringify(followupInput), /Лебедь Борис/);
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
      adaptLegacyAiFake(aiFetch),
    ),
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const current = await app.archive.read(),
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
    await app.archive.write(
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
    assert.match(JSON.stringify(requests[2].messages), /get_family/);
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
                  id: "person-call",
                  type: "function",
                  function: {
                    name: "search_people",
                    arguments: '{"query":"Татьяна Вьюхина"}',
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
              content:
                "У [[person:tatyana-cousins|Вьюхина Татьяна Ивановна]] есть родные сёстры.",
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
      adaptLegacyAiFake(aiFetch),
    ),
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const current = await app.archive.read(),
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
    await app.archive.write(
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
    const firstResponse = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Какие родственники есть у Татьяны?" }),
    });
    assert.equal(firstResponse.status, 200);
    const firstPayload = await firstResponse.json();
    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "а двоюродные",
        chatId: firstPayload.chatId,
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.match(payload.answer, /Василий/);
    assert.equal(requests.length, 3);
    assert.match(JSON.stringify(requests[2].messages), /а двоюродные/);
    assert.match(JSON.stringify(requests[2].messages), /tatyana-cousins/);
    assert.match(JSON.stringify(requests[2].tools), /get_cousins/);
    assert.match(payload.answer, /\[\[person:vasily-cousins\|/);
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
    adaptLegacyAiFake(aiFetch),
  );
  const base =
    "http://127.0.0.1:" + (app.server.address() as { port: number }).port;

  try {
    const current = await app.archive.read();
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
    await app.archive.write(family, current.revision);
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
      /только людей из области общих предков.*доступ только для чтения/,
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
        context: {
          view: "tree",
          personIds: ["anna-ai-test"],
          openPersonId: "anna-ai-test",
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.match(
      JSON.stringify(requests[0].body.messages),
      /Сейчас открыта карточка человека Лебедь Анна Семёновна/,
    );
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
    const zoomResponse = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "так ты приблизь",
        context: { view: "tree", personIds: ["anna-ai-test"] },
      }),
    });
    assert.equal(zoomResponse.status, 200);
    const zoom = await zoomResponse.json();
    assert.equal(zoom.answer, "Приблизил древо.");
    assert.deepEqual(zoom.uiActions, [{ type: "zoom_in" }]);
    assert.equal(
      requests.length,
      2,
      "короткое действие не требует вызова модели",
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
    const filteredResponse = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "отобрази на древе Лебедь только и её ближайших предков",
        context: { view: "tree" },
      }),
    });
    assert.equal(filteredResponse.status, 200);
    const filtered = await filteredResponse.json();
    assert.deepEqual(filtered.uiActions, [
      { type: "filter_people", personIds: ["anna-ai-test"], label: "Лебедь" },
    ]);
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
      adaptLegacyAiFake(aiFetch),
    ),
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const current = await app.archive.read();
    await app.archive.write(
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
        context: { view: "gallery", openPhotoId: "photo-ai" },
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
    assert.match(
      JSON.stringify(requests[0].messages),
      /Текущий раздел интерфейса: gallery/,
    );
    assert.match(
      JSON.stringify(requests[0].messages),
      /Сейчас открыт снимок «Семейный снимок»/,
    );
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
