import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { researchPdf } from "../src/server/research-pdf.ts";

test("PDF contains Cyrillic text and is a real PDF", async () => {
  const bytes = await researchPdf(
    "Семейный архив",
    "Анна Семёновна\n\n- Запись о рождении",
  );
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  assert.ok(bytes.length > 1000);
  await assert.rejects(researchPdf("", "текст"), RangeError);
});

test("PDF draws a separate page from verified people and relationship edges", async () => {
  const bytes = await researchPdf(
    "Родственные связи",
    "Семья из трёх человек.",
    {
      nodes: [
        { id: "mother", name: "Анна Семёновна" },
        { id: "father", name: "Иван Петрович" },
        { id: "child", name: "Мария Ивановна" },
      ],
      edges: [
        { from: "mother", to: "child", type: "parent" },
        { from: "father", to: "child", type: "parent" },
        { from: "mother", to: "father", type: "spouse" },
      ],
    },
  );
  assert.match(bytes.toString("latin1"), /\/Count 2\b/);
  assert.ok(bytes.length > 4000);
});

test("AI attaches a downloadable PDF only to an explicit PDF request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-pdf-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let calls = 0;
  const aiFetch: typeof fetch = async () => {
    calls++;
    const delta =
      calls === 1
        ? {
            content:
              '```\ncreate_pdf\n{"title":"Отчёт о семье","content":"Анна Семёновна — запись о рождении."}\n```',
          }
        : {
            content:
              "Готово, отчёт приложен. Ссылка: /api/ai/files/7449c409-8874-4739-8574-158fab22f458",
          };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
      {
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  };
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    aiFetch,
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const response = await fetch(base + "/api/ai/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Дай мне PDF с данными семьи" }),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /Готовлю PDF/);
    const done = /event: done\ndata: (.+)/.exec(stream);
    assert.ok(done);
    const result = JSON.parse(done[1]) as {
      answer: string;
      files: Array<{ name: string; url: string }>;
    };
    assert.equal(result.answer.trim(), "Готово, отчёт приложен.");
    assert.doesNotMatch(stream, /Соединение установлено/);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, "Отчёт о семье.pdf");
    const file = await fetch(base + result.files[0].url);
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") || "", /application\/pdf/);
    assert.equal(
      Buffer.from(await file.arrayBuffer())
        .subarray(0, 5)
        .toString(),
      "%PDF-",
    );
    assert.equal((await fetch(base + "/api/ai/files/unknown")).status, 404);
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

test("a requested relationship graph is embedded in the downloaded PDF", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-pdf-graph-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let calls = 0;
  const aiFetch: typeof fetch = async () => {
    const delta =
      ++calls === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "graph-pdf",
                type: "function",
                function: {
                  name: "create_pdf",
                  arguments: JSON.stringify({
                    title: "Родство",
                    content: "Анализ семьи.",
                  }),
                },
              },
            ],
          }
        : { content: "Файл со схемой родства приложен." };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
      {
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  };
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    aiFetch,
  );
  try {
    const snapshot = app.archive.read();
    app.archive.write(
      {
        ...snapshot.family,
        people: [
          {
            id: "parent",
            name: "Анна",
            surname: "Иванова",
            patronymic: "",
            birthPlace: "",
            sex: "f",
            birth: "1900",
            parents: [],
            spouses: [],
            generation: 1,
            column: 0,
            sources: [],
          },
          {
            id: "child",
            name: "Мария",
            surname: "Иванова",
            patronymic: "",
            birthPlace: "",
            sex: "f",
            birth: "1930",
            parents: ["parent"],
            spouses: [],
            generation: 2,
            column: 0,
            sources: [],
          },
        ],
      },
      snapshot.revision,
    );
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const response = await fetch(base + "/api/ai/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Сделай PDF, в документе нужен граф связей",
      }),
    });
    const stream = await response.text();
    const done = /event: done\ndata: (.+)/.exec(stream);
    assert.ok(done);
    const result = JSON.parse(done[1]) as { files: Array<{ url: string }> };
    assert.equal(result.files.length, 1);
    const file = await fetch(base + result.files[0].url);
    assert.match(
      Buffer.from(await file.arrayBuffer()).toString("latin1"),
      /\/Count 2\b/,
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

test("a model claim without a generated file never becomes a download link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-pdf-claim-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let calls = 0;
  const aiFetch: typeof fetch = async () => {
    calls++;
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "PDF готов: /api/ai/files/7449c409-8874-4739-8574-158fab22f458" } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    aiFetch,
  );
  try {
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const response = await fetch(base + "/api/ai/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Сформируй PDF" }),
    });
    const stream = await response.text();
    const done = /event: done\ndata: (.+)/.exec(stream);
    assert.ok(done);
    const result = JSON.parse(done[1]) as { answer: string; files: unknown[] };
    assert.deepEqual(result.files, []);
    assert.match(result.answer, /Не удалось создать PDF/);
    assert.doesNotMatch(stream, /event: delta\ndata: .*api\/ai\/files/);
    assert.ok(calls >= 2);
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
