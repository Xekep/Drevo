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
            tool_calls: [
              {
                index: 0,
                id: "pdf-call",
                type: "function",
                function: {
                  name: "create_pdf",
                  arguments: JSON.stringify({
                    title: "Отчёт о семье",
                    content: "Анна Семёновна — запись о рождении.",
                  }),
                },
              },
            ],
          }
        : { content: "Готово, отчёт приложен." };
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
    assert.equal(result.answer, "Готово, отчёт приложен.");
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
