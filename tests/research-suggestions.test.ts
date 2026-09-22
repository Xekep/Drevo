import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { Family } from "../src/domain/types.ts";

test("AI person update stays pending until a human accepts it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-suggestion-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";

  let call = 0;
  const aiFetch: typeof fetch = async () => {
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
                  id: "proposal-1",
                  type: "function",
                  function: {
                    name: "propose_person_update",
                    arguments: JSON.stringify({
                      personId: "anna-suggestion-test",
                      changes: {
                        birthPlace: "Нижнее, Луганская область",
                      },
                      reason:
                        "Пользователь попросил сохранить уточнённое место рождения.",
                      evidence: [
                        "Уточнение пользователя в текущем исследовательском диалоге.",
                      ],
                    }),
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
              "Создано предложение. Оно не изменит карточку без подтверждения.",
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
    base =
      "http://127.0.0.1:" +
      (app.server.address() as { port: number }).port;

  try {
    const current = app.archive.read(),
      family: Family = {
        ...current.family,
        people: [
          ...current.family.people,
          {
            id: "anna-suggestion-test",
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

    const chat = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Сохрани уточнение места рождения Анны как предложение.",
        context: { view: "tree", personIds: ["anna-suggestion-test"] },
      }),
    });
    assert.equal(chat.status, 200);

    const before = app.archive
      .read()
      .family.people.find((person) => person.id === "anna-suggestion-test");
    assert.equal(before?.birthPlace, "Нижнее");

    const queueResponse = await fetch(base + "/api/research/suggestions");
    assert.equal(queueResponse.status, 200);
    const queue = await queueResponse.json();
    assert.equal(queue.suggestions.length, 1);
    assert.equal(queue.suggestions[0].personName, "Лебедь Анна Семёновна");
    assert.equal(
      queue.suggestions[0].payload.changes.birthPlace,
      "Нижнее, Луганская область",
    );

    const accepted = await fetch(
      base +
        "/api/research/suggestions/" +
        encodeURIComponent(queue.suggestions[0].id) +
        "/accept",
      { method: "POST" },
    );
    assert.equal(accepted.status, 200);

    const after = app.archive
      .read()
      .family.people.find((person) => person.id === "anna-suggestion-test");
    assert.equal(after?.birthPlace, "Нижнее, Луганская область");

    const emptyQueue = await fetch(base + "/api/research/suggestions").then(
      (response) => response.json(),
    );
    assert.equal(emptyQueue.suggestions.length, 0);
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
