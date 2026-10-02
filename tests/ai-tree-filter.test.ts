import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { Person } from "../src/domain/types.ts";

test("a tree exclusion uses one compact tool call after token recovery, preserves all other people and continues the chat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-ai-tree-filter-"));
  const env = {
    YANDEX_AI_API_KEY: "test-key",
    YANDEX_AI_FOLDER_ID: "folder",
    YANDEX_AI_MODEL: "yandexgpt/rc",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  const requests: Array<Record<string, unknown>> = [];
  let conversations = 0;
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations"))
      return Response.json({ id: `conv-${++conversations}` });
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (requests.length === 1)
      return Response.json({
        id: "limited",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      });
    assert.equal(
      requests.length <= 3,
      true,
      "display actions need no second synthesis call",
    );
    assert.ok(
      body.tools.some(
        (tool: { name: string }) => tool.name === "control_archive_view",
      ),
    );
    const completion = {
      id: `response-${requests.length}`,
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "filter",
          name: "control_archive_view",
          arguments: JSON.stringify({
            action: "filter_by_criteria",
            mode: "exclude",
            criteria: { deathAgeBefore: 18 },
            ...(requests.length === 2
              ? { label: "Без умерших до 18 лет" }
              : {}),
          }),
        },
      ],
    };
    return body.stream
      ? new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: completion })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        )
      : Response.json(completion);
  };
  const app = await startServer(
    0,
    join(directory, "drevo.sqlite"),
    true,
    undefined,
    fake,
  );
  try {
    const current = await app.archive.read();
    const person = (id: string, death?: string): Person => ({
      id,
      name: id,
      surname: "Тест",
      patronymic: "",
      birth: "2000-01-01",
      birthPlace: "",
      death,
      sex: "u",
      parents: [],
      spouses: [],
      generation: 1,
      column: 0,
      sources: [],
    });
    await app.archive.write(
      {
        ...current.family,
        people: [
          ...Array.from({ length: 500 }, (_, index) =>
            person(`living-${index}`),
          ),
          person("child", "2010-01-01"),
          person("adult", "2018-01-01"),
        ],
      },
      current.revision,
    );
    const before = await app.archive.read();
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          "нет оставь все древо убери только тех людей которые умерли до 18 лет",
        context: { view: "tree" },
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(requests.length, 2);
    assert.equal(conversations, 2);
    assert.equal(requests[1].max_output_tokens, 16000);
    assert.equal(result.uiActions[0].personIds.length, 501);
    assert.equal(result.uiActions[0].personIds.includes("child"), false);
    assert.equal(result.uiActions[0].personIds.includes("adult"), true);
    assert.match(result.answer, /Исключил из показа 1 карточку/);
    assert.deepEqual(
      await app.archive.read(),
      before,
      "view control never edits or deletes the archive",
    );
    const followup = await fetch(base + "/api/ai/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: result.chatId,
        message: "скрой умерших младше 18 лет",
        context: { view: "tree" },
      }),
    });
    const stream = await followup.text();
    assert.match(stream, /event: done/);
    assert.doesNotMatch(stream, /event: error/);
    assert.equal(requests.length, 3);
    assert.equal(
      conversations,
      3,
      "the next turn has no pending remote function call",
    );
    assert.match(
      JSON.stringify(requests[2].input),
      /Исключил из показа 1 карточку/,
    );
    const chat = await (
      await fetch(base + `/api/ai/chats/${result.chatId}`)
    ).json();
    assert.equal(
      chat.messages.filter(
        (item: { role: string }) => item.role === "assistant",
      ).length,
      2,
    );
  } finally {
    await app.close();
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a filter in a batch retains other analysis and sends only counts back to the model", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-ai-filter-analysis-"));
  const env = {
    YANDEX_AI_API_KEY: "test-key",
    YANDEX_AI_FOLDER_ID: "folder",
    YANDEX_AI_MODEL: "yandexgpt/rc",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  let calls = 0;
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations"))
      return Response.json({ id: "conv" });
    const body = JSON.parse(String(init?.body));
    if (++calls === 1)
      return Response.json({
        id: "tools",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "filter",
            name: "control_archive_view",
            arguments: JSON.stringify({
              action: "filter_by_criteria",
              mode: "exclude",
              criteria: { deathAgeBefore: 18 },
            }),
          },
          {
            type: "function_call",
            call_id: "analysis",
            name: "get_archive_insights",
            arguments: "{}",
          },
        ],
      });
    assert.equal(calls, 2);
    assert.deepEqual(
      body.input.map((item: { call_id: string }) => item.call_id),
      ["filter", "analysis"],
    );
    const filtered = JSON.parse(body.input[0].output);
    assert.equal(filtered.scheduled, true);
    assert.equal(typeof filtered.visibleCount, "number");
    assert.equal(filtered.personIds, undefined);
    assert.equal(filtered.action, undefined);
    assert.ok(JSON.parse(body.input[1].output).completeness);
    return Response.json({
      id: "done",
      status: "completed",
      output_text: "Обзор составлен, фильтр применён.",
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
    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Проанализируй всё древо и исключи умерших до 18 лет",
        context: { view: "tree" },
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.answer, "Обзор составлен, фильтр применён.");
    assert.equal(result.uiActions.length, 1);
    assert.equal(calls, 2);
  } finally {
    await app.close();
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
