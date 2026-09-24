import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { adaptLegacyAiFake } from "./legacy-ai-fake.ts";
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
      adaptLegacyAiFake(aiFetch),
    ),
    base =
      "http://127.0.0.1:" + (app.server.address() as { port: number }).port;

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
    const chatResult = await chat.json();
    assert.equal(chatResult.suggestionIds.length, 1);
    assert.match(chatResult.answer, /нажмите ✓/);

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

    const textConfirmation = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "подтверждаю" }),
    }).then((response) => response.json());
    assert.match(textConfirmation.answer, /кнопки ✓ или ×/);
    assert.deepEqual(textConfirmation.suggestionIds, [queue.suggestions[0].id]);
    assert.equal(call, 2);

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

test("AI source and relation proposals require separate human acceptance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-suggestion-extra-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";

  const aiFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content?: string }>;
      tools: Array<{ function: { name: string } }>;
    };
    const toolNames = body.tools.map((tool) => tool.function.name);
    assert.ok(toolNames.includes("propose_source"));
    assert.ok(toolNames.includes("propose_relation"));
    assert.ok(toolNames.includes("propose_person_create"));

    if (body.messages.some((message) => message.role === "tool"))
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Предложение создано и ждёт подтверждения.",
            },
          },
        ],
      });

    const request =
      [...body.messages].reverse().find((message) => message.role === "user")
        ?.content || "";
    if (request.includes("новую карточку"))
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "person-create-1",
                  type: "function",
                  function: {
                    name: "propose_person_create",
                    arguments: JSON.stringify({
                      person: {
                        surname: "Пупкин",
                        name: "Василий",
                        sex: "m",
                        birth: "1991",
                      },
                      reason: "Пользователь просит добавить человека.",
                      evidence: ["Сведения переданы пользователем."],
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    if (request.includes("источник"))
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "source-1",
                  type: "function",
                  function: {
                    name: "propose_source",
                    arguments: JSON.stringify({
                      personId: "anna-source-test",
                      source: {
                        title: "Архивная запись",
                        type: "archive",
                        reference: "Ф. 1, оп. 2, д. 3",
                      },
                      reason:
                        "Пользователь просит сохранить найденный источник.",
                      evidence: ["Архивный шифр передан пользователем."],
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
            content: null,
            tool_calls: [
              {
                id: "relation-1",
                type: "function",
                function: {
                  name: "propose_relation",
                  arguments: JSON.stringify({
                    fromPersonId: "anna-source-test",
                    toPersonId: "child-relation-test",
                    relationType: "parent",
                    reason: "Пользователь просит сохранить гипотезу о родстве.",
                    evidence: ["Родство пока требует ручного подтверждения."],
                  }),
                },
              },
            ],
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
    base =
      "http://127.0.0.1:" + (app.server.address() as { port: number }).port;

  try {
    const current = app.archive.read(),
      family: Family = {
        ...current.family,
        people: [
          ...current.family.people,
          {
            id: "anna-source-test",
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
          {
            id: "child-relation-test",
            surname: "Скулко",
            name: "Василий",
            patronymic: "Митрофанович",
            sex: "m",
            birth: "1940-05-22",
            birthPlace: "",
            parents: [],
            spouses: [],
            generation: 2,
            column: 0,
            sources: [],
          },
        ],
      };
    app.archive.write(family, current.revision);

    const sourceChat = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Сохрани этот источник как предложение.",
        context: { view: "tree", personIds: ["anna-source-test"] },
      }),
    });
    assert.equal(sourceChat.status, 200);
    assert.equal(
      app.archive
        .read()
        .family.people.find((person) => person.id === "anna-source-test")
        ?.sources.length,
      0,
    );

    let queue = await fetch(base + "/api/research/suggestions").then(
      (response) => response.json(),
    );
    const sourceSuggestion = queue.suggestions.find(
      (item: { kind: string }) => item.kind === "source",
    );
    assert.ok(sourceSuggestion);
    assert.equal(sourceSuggestion.payload.source.title, "Архивная запись");

    const sourceAccepted = await fetch(
      base +
        "/api/research/suggestions/" +
        encodeURIComponent(sourceSuggestion.id) +
        "/accept",
      { method: "POST" },
    );
    assert.equal(sourceAccepted.status, 200);
    assert.equal(
      app.archive
        .read()
        .family.people.find((person) => person.id === "anna-source-test")
        ?.sources[0]?.reference,
      "Ф. 1, оп. 2, д. 3",
    );

    const relationChat = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Предложи сохранить это родство.",
        context: {
          view: "tree",
          personIds: ["anna-source-test", "child-relation-test"],
        },
      }),
    });
    assert.equal(relationChat.status, 200);
    assert.equal(
      app.archive
        .read()
        .family.people.find((person) => person.id === "child-relation-test")
        ?.parents.includes("anna-source-test"),
      false,
    );

    queue = await fetch(base + "/api/research/suggestions").then((response) =>
      response.json(),
    );
    const relationSuggestion = queue.suggestions.find(
      (item: { kind: string }) => item.kind === "relation",
    );
    assert.ok(relationSuggestion);
    assert.equal(relationSuggestion.fromName, "Лебедь Анна Семёновна");
    assert.equal(relationSuggestion.toName, "Скулко Василий Митрофанович");

    const relationAccepted = await fetch(
      base +
        "/api/research/suggestions/" +
        encodeURIComponent(relationSuggestion.id) +
        "/accept",
      { method: "POST" },
    );
    assert.equal(relationAccepted.status, 200);
    assert.equal(
      app.archive
        .read()
        .family.people.find((person) => person.id === "child-relation-test")
        ?.parents.includes("anna-source-test"),
      true,
    );

    const createChat = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Создай новую карточку Василия Пупкина, 1991 год.",
        context: { view: "tree", personIds: [] },
      }),
    });
    assert.equal(createChat.status, 200);
    const createResult = await createChat.json();
    assert.equal(
      createResult.suggestionIds.length,
      1,
      JSON.stringify(createResult),
    );
    assert.equal(
      app.archive
        .read()
        .family.people.some((person) => person.surname === "Пупкин"),
      false,
    );
    queue = await fetch(base + "/api/research/suggestions").then((response) =>
      response.json(),
    );
    const createSuggestion = queue.suggestions.find(
      (item: { kind: string }) => item.kind === "person_create",
    );
    assert.equal(createSuggestion.personName, "Пупкин Василий");
    const createAccepted = await fetch(
      `${base}/api/research/suggestions/${encodeURIComponent(createSuggestion.id)}/accept`,
      { method: "POST" },
    );
    assert.equal(createAccepted.status, 200);
    assert.equal(
      app.archive
        .read()
        .family.people.some(
          (person) => person.surname === "Пупкин" && person.birth === "1991",
        ),
      true,
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
