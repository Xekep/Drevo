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
    greetingCalls = 0,
    namedId = "";
  const providerRequests: Array<{ phase: string; input: unknown; instructions: string; conversation: string }> = [];
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations"))
      return Response.json({ id: "conv-topic" });
    const body = JSON.parse(String(init?.body));
    providerRequests.push({ phase, input: body.input, instructions: body.instructions, conversation: body.conversation });
    if (phase === "archive") {
      phase = "archive-lookup";
      return Response.json({ id: "unverified-answer", status: "completed", output_text: "В архиве нет данных." });
    }
    if (phase === "archive-lookup") {
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
    if (phase === "person") {
      phase = "person-result";
      return Response.json({
        id: `person-${namedId}`,
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: `call-${namedId}`,
            name: "get_person",
            arguments: JSON.stringify({ personId: namedId }),
          },
        ],
      });
    }
    if (phase === "person-result")
      return Response.json({
        id: `person-answer-${namedId}`,
        status: "completed",
        output_text: `Вот найденная карточка: [[person:${namedId}|Тестовый человек]].`,
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
    // This scenario exercises several user turns, independently of rate limits.
    await app.archive.db
      .prepare(
        "UPDATE ai_settings SET requests_per_minute=50,daily_tokens=5000000 WHERE id=1",
        "UPDATE platform_ai_settings SET requests_per_minute=50,daily_tokens=5000000 WHERE id=1",
      )
      .run();
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const ask = async (message: string, chatId?: string) => {
      const response = await fetch(base + "/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, chatId, context: { view: "tree" } }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, payload.error);
      return payload;
    };
    const first = await ask("Сколько людей с датой рождения в архиве?");
    assert.match(providerRequests[1].instructions, /Предыдущий ответ не был проверен по архиву/);
    assert.doesNotMatch(JSON.stringify(providerRequests[1].input), /Предыдущий ответ не был проверен по архиву/,
      "a validation retry is transient instructions, never an additional user message");
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
    const greetingRequest = providerRequests.find(request => request.phase === "greeting")!;
    assert.match(greetingRequest.instructions, /Текущая задача пользователя/);
    assert.doesNotMatch(greetingRequest.instructions, /Предыдущий ответ не был проверен по архиву/,
      "a new turn must not inherit the previous turn's retry instruction");
    assert.equal(greetingRequest.conversation, providerRequests[0].conversation,
      "topic changes retain native conversation state instead of guessing what history to delete");
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
    const snapshot = await app.archive.read();
    await app.archive.write(
      {
        ...snapshot.family,
        photos: [],
        links: [],
        unions: [],
        people: ["subject-a", "subject-b"].map((id) => ({
          id,
          name: id,
          surname: "Тест",
          patronymic: "",
          birth: "1900",
          birthPlace: "",
          sex: "u" as const,
          generation: 1,
          column: 0,
          sources: [],
          parents: [],
          spouses: [],
          photo: undefined,
        })),
      },
      snapshot.revision,
    );
    for (const id of ["subject-a", "subject-b"]) {
      namedId = id;
      phase = "person";
      const result = await ask(`Расскажи о человеке ${id}`, first.chatId);
      assert.ok(
        result.references.some(
          (reference: { kind: string; id: string }) =>
            reference.kind === "person" && reference.id === id,
        ),
      );
      const saved = await app.archive.db
        .prepare(
          "SELECT session_state FROM ai_chats WHERE id=?",
          "SELECT session_state FROM ai_chats WHERE id=?",
        )
        .get(first.chatId);
      assert.deepEqual(
        JSON.parse(String(saved?.session_state)).activePersonIds,
        [id],
        "a newly discussed person replaces previous active subjects",
      );
    }
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
