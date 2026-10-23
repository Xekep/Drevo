import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

test("switching from archive research to a standalone greeting does not force a stale lookup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-ai-topic-"));
  const env = {
    YANDEX_AI_API_KEY: "test-key",
    YANDEX_AI_FOLDER_ID: "folder",
    YANDEX_AI_MODEL: "yandexgpt/rc",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  let phase = "archive",
    greetingCalls = 0;
  const providerRequests: Array<{ phase: string; input: unknown }> = [];
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations"))
      return Response.json({ id: "conv-topic" });
    const body = JSON.parse(String(init?.body));
    providerRequests.push({ phase, input: body.input });
    if (phase === "archive") {
      phase = "archive-result";
      return Response.json({
        id: "lookup",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "count",
            name: "query_people",
            arguments: JSON.stringify({
              criteria: { hasBirthDate: true },
              limit: 0,
            }),
          },
        ],
      });
    }
    if (phase === "archive-result")
      return Response.json({
        id: "archive-result",
        status: "completed",
        output_text: "Посчитал людей с датой рождения в архиве.",
      });
    greetingCalls++;
    return Response.json({
      id: `greeting-${greetingCalls}`,
      status: "completed",
      output_text: "Добро пожаловать! Пусть здесь будет уютно.",
    });
  };
  const app = await startServer(
    0,
    join(directory, "drevo.sqlite"),
    true,
    undefined,
    fake,
  );
  try {
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const ask = async (message: string, chatId?: string) => {
      const response = await fetch(base + "/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, chatId, context: { view: "tree" } }),
      });
      assert.equal(response.status, 200);
      return await response.json();
    };
    const first = await ask("Сколько людей с датой рождения в архиве?");
    phase = "greeting";
    const continued = await ask(
      "Теперь другая тема: напиши короткое приветствие гостям сайта, без поиска данных.",
      first.chatId,
    );
    const continuedCalls = greetingCalls;
    greetingCalls = 0;
    const fresh = await ask(
      "Теперь другая тема: напиши короткое приветствие гостям сайта, без поиска данных.",
    );
    assert.equal(continued.answer, fresh.answer);
    assert.equal(greetingCalls, 1, "a fresh chat needs one response");
    assert.equal(
      continuedCalls,
      1,
      "an independent new topic must not inherit archive lookup intent",
    );
    assert.equal(
      providerRequests
        .filter((request) => request.phase === "greeting")
        .some((request) =>
          JSON.stringify(request.input).includes(
            "Предыдущий ответ не был проверен по архиву",
          ),
        ),
      false,
    );
    phase = "archive";
    const returned = await ask(
      "Вернёмся к архиву: сколько людей с датой рождения?",
      first.chatId,
    );
    assert.equal(
      returned.chatId,
      first.chatId,
      "switching topics must not reset the user's chat",
    );
    assert.match(returned.answer, /Посчитал людей/);
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
