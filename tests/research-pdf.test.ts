import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { researchPdf } from "../src/server/research-pdf.ts";
import { parseResearchMermaid } from "../src/server/research-pdf-visuals.ts";

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

test("большая схема занимает один отдельный лист A4, диаграммы помещаются на A4", async () => {
  const nodes = Array.from({ length: 111 }, (_, index) => ({
    id: `p${index}`,
    name: `Чепчугов Человек ${index}`,
  }));
  const edges = nodes.slice(1).map((person, index) => ({
    from: `p${Math.floor(index / 2)}`,
    to: person.id,
    type: "parent",
  }));
  const bytes = await researchPdf(
    "Полный анализ",
    [
      "## Статистика",
      "| Поколение | Люди |",
      "| --- | ---: |",
      "| Первое | 7 |",
      "```mermaid",
      "pie",
      "  title Распределение по полу",
      '  "Мужчины" : 53',
      '  "Женщины" : 58',
      "```",
      "```mermaid",
      "xychart-beta",
      '  title "По поколениям"',
      '  x-axis ["Первое", "Второе", "Третье"]',
      "  bar [7, 24, 80]",
      "```",
    ].join("\n"),
    { nodes, edges },
  );
  const source = bytes.toString("latin1"),
    pageCount = Number(/\/Count (\d+)/.exec(source)?.[1]),
    sizes = [...source.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)];
  assert.equal(pageCount, 4, "текст, круговая диаграмма, график и схема");
  assert.equal(sizes.length, pageCount);
  for (const [, width, height] of sizes) {
    assert.deepEqual(
      [Number(width), Number(height)].sort((a, b) => a - b),
      [595.28, 841.89],
      `ожидался один лист A4: ${width} × ${height}`,
    );
  }
  assert.ok(bytes.length > 8000);
});

test("Mermaid из ответа превращается в схему или график, а неизвестный формат отвергается", async () => {
  assert.deepEqual(
    parseResearchMermaid("graph TD\na[Анна] --> b[Иван]").kind,
    "graph",
  );
  assert.deepEqual(
    parseResearchMermaid('xychart-beta\nx-axis ["1900", "2000"]\nline [1, 4]')
      .kind,
    "chart",
  );
  const bytes = await researchPdf(
    "Проверка схемы",
    "Описание подтверждённой связи.\n```mermaid\ngraph TD\na[Анна] --> b[Иван]\n```",
  );
  assert.match(bytes.toString("latin1"), /\/Count 2\b/);
  await assert.rejects(
    researchPdf("Архив", "```mermaid\nsequenceDiagram\nA->>B: связь\n```"),
    /поддерживаются Mermaid/,
  );
  assert.equal(parseResearchMermaid("graph TD\na -->|связь| b").kind, "graph");
  assert.throws(
    () => parseResearchMermaid("graph TD\na --> b --> c"),
    /неподдерживаемом формате/,
  );
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
              "Готово, отчёт приложен. Вы можете скачать файл по ссылке: ``",
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
