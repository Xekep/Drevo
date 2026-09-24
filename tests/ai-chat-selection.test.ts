import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

test("person choice continues a chat without exposing an internal user message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-choice-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  const requests: Array<Record<string, unknown>> = [];
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations"))
      return Response.json({ id: "conversation-1" });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    return Response.json({
      id: `response-${requests.length}`,
      status: "completed",
      output_text:
        requests.length === 2
          ? "Уточнение к предыдущему вопросу: речь о Петрове."
          : "Понял, продолжаю.",
      output: [],
      usage: { input_tokens: 10, output_tokens: 3 },
    });
  };
  const app = await startServer(
    0,
    join(dir, "drevo.sqlite"),
    true,
    undefined,
    fake,
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const snapshot = app.archive.read();
    app.archive.write(
      {
        ...snapshot.family,
        people: [
          {
            id: "person-42",
            surname: "Петров",
            name: "Иван",
            patronymic: "Петрович",
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
      snapshot.revision,
    );
    const send = async (body: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return {
        response,
        data: (await response.json()) as { chatId: string; answer: string },
      };
    };
    const first = await send({ message: "Расскажи об Иване" });
    assert.equal(first.response.status, 200);
    const choice = await send({
      message: "",
      chatId: first.data.chatId,
      selectedPersonId: "person-42",
    });
    assert.equal(choice.response.status, 200);
    assert.equal(choice.data.chatId, first.data.chatId);
    assert.equal(choice.data.answer, "Понял, продолжаю.");
    assert.match(
      JSON.stringify(requests[1].input),
      /Петров Иван Петрович/,
    );
    assert.match(
      String(requests.at(-1)?.instructions),
      /лёгкой ненавязчивой шуткой/,
    );

    const detail = await fetch(
      `${base}/api/ai/chats/${first.data.chatId}`,
    ).then((response) => response.json());
    assert.deepEqual(
      detail.messages.map((item: { role: string }) => item.role),
      ["user", "assistant", "assistant"],
    );
    assert.doesNotMatch(
      JSON.stringify(detail),
      /person-42|Выбран вариант|hidden/,
    );
    const list = await fetch(`${base}/api/ai/chats`).then((response) =>
      response.json(),
    );
    assert.equal(list.chats[0].title, "Расскажи об Иване");

    const denied = await send({
      message: "",
      chatId: first.data.chatId,
      selectedPersonId: "missing-person",
    });
    assert.equal(denied.response.status, 404);
    assert.equal(requests.length, 3);
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
