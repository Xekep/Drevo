import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { yandexResponsesClient, YandexResponseError } from "../src/server/yandex-responses.ts";
import { startServer } from "../src/server/index.ts";
import { aiSettingsStore } from "../src/server/ai-settings.ts";

const options = {
  runtime: { baseUrl: "https://provider.invalid/v1", modelUri: "gpt://folder/model", apiKey: "test-key", folderId: "folder" },
  conversationId: "initial-conversation", input: "Проверка", instructions: "Ответь по данным",
  tools: [{ type: "function" as const, name: "get_family", description: "Проверить семью", parameters: { type: "object", properties: {} } }],
  compactThreshold: 32000, automaticTruncation: true,
};
const failed = { id: "failed-response", status: "failed", error: { code: "invalid_prompt", message: "No user query found in messages. (in tool_use:79)" }, output: [{ type: "compaction" }] };
const completed = { id: "completed-response", status: "completed", output_text: "Проверено", output: [] };

for (const stream of [false, true]) test(`compaction template failure disables only that endpoint/model without retrying the damaged conversation (${stream ? "SSE" : "JSON"})`, async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = yandexResponsesClient(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), body });
    if (requests.length === 1) return stream
      ? new Response(`data: ${JSON.stringify({ type: "response.failed", response: failed })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
      : Response.json(failed);
    return body.stream
      ? new Response(`data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
      : Response.json(completed);
  });
  const settings = structuredClone(options);
  await assert.rejects(client.respond({ ...options, stream }), error => error instanceof YandexResponseError && error.status === 502 && error.code === "invalid_prompt" && error.responseId === "failed-response");
  assert.equal(requests.length, 1, "the adapter must not retry the possibly compacted conversation");
  const recovered = await client.respond({ ...options, conversationId: "fresh-recovery", stream });
  assert.equal(recovered.compactionAvailable, false);
  assert.equal(requests[1].body.context_management, undefined);
  assert.equal(requests[1].body.conversation, "fresh-recovery");
  assert.deepEqual(requests[1].body.tools, options.tools);
  assert.deepEqual(options, settings, "compatibility detection never changes saved/configured settings");
  for (const runtime of [{ ...options.runtime, modelUri: "gpt://folder/other-model" }, { ...options.runtime, baseUrl: "https://other-provider.invalid/v1" }]) {
    assert.equal((await client.respond({ ...options, runtime, stream })).compactionAvailable, true);
    assert.deepEqual(requests.at(-1)!.body.context_management, [{ type: "compaction", compact_threshold: 32000 }]);
  }
});

for (const stream of [false, true]) for (const scenario of [
  { label: "ordinary invalid prompt", response: { ...failed, output: [] }, enabled: true },
  { label: "other provider error after compaction", response: { ...failed, error: { ...failed.error, code: "server_error" } }, enabled: true },
  { label: "compaction not requested", response: failed, enabled: false },
]) test(`${scenario.label} does not disable future automatic compaction (${stream ? "SSE" : "JSON"})`, async () => {
  const bodies: Record<string, unknown>[] = [];
  const client = yandexResponsesClient(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const data = bodies.length === 1 ? scenario.response : completed;
    return stream ? new Response(`data: ${JSON.stringify({ type: data.status === "failed" ? "response.failed" : "response.completed", response: data })}\n\n`, { headers: { "Content-Type": "text/event-stream" } }) : Response.json(data);
  });
  await assert.rejects(client.respond({ ...options, compactThreshold: scenario.enabled ? 32000 : null, stream }), YandexResponseError);
  assert.equal((await client.respond({ ...options, stream })).compactionAvailable, true);
  assert.deepEqual(bodies[1].context_management, [{ type: "compaction", compact_threshold: 32000 }]);
});

test("runner recovers compaction failure on a new conversation without repeating completed tools or changing settings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-compaction-recovery-"));
  const env = { YANDEX_AI_API_KEY: "test-key", YANDEX_AI_FOLDER_ID: "folder", YANDEX_AI_MODEL: "test-model" };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const bodies: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => { try { events.push(JSON.parse(String(args[0]))); } catch { /* Not a structured event. */ } };
  let conversations = 0;
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations")) return Response.json({ id: `conversation-${++conversations}` });
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (bodies.length === 1) return Response.json({ id: "archive-tool", status: "completed", output: [{ type: "function_call", call_id: "insights", name: "get_archive_insights", arguments: "{}" }] });
    if (bodies.length === 2) {
      assert.equal(body.input[0].type, "function_call_output");
      assert.equal(body.input[0].call_id, "insights");
      return Response.json(failed);
    }
    if (bodies.length === 3) {
      assert.equal(body.conversation, "conversation-2");
      assert.equal(body.context_management, undefined);
      assert.deepEqual(body.tools, []);
      assert.match(JSON.stringify(body.input), /get_archive_insights/);
      assert.match(JSON.stringify(body.input), /totals/);
      return Response.json({ ...completed, id: "recovered-answer", output_text: "В архиве один человек." });
    }
    assert.equal(body.conversation, "conversation-2");
    assert.equal(body.context_management, undefined);
    assert.ok(body.tools.some((tool: { name: string }) => tool.name === "propose_person_update"));
    if (bodies.length === 4) return Response.json({ id: "proposal-tool", status: "completed", output: [{ type: "function_call", call_id: "proposal", name: "propose_person_update", arguments: JSON.stringify({ personId: "alex", changes: { birth: "1994" }, reason: "Уточнение пользователя", evidence: ["Текущий запрос"] }) }] });
    return Response.json({ ...completed, id: "proposal-answer", output_text: "Предложение подготовлено." });
  };
  const app = await startServer(0, join(directory, "test.sqlite"), true, undefined, fake);
  try {
    const initial = await app.archive.read();
    await app.archive.write({ ...initial.family, people: [{ id: "alex", surname: "Тест", name: "Алексей", patronymic: "", sex: "m", birth: "1980", birthPlace: "", parents: [], spouses: [], sources: [], generation: 1, column: 0 }] }, initial.revision);
    const baseline = await app.archive.read();
    const settings = await aiSettingsStore(app.archive.db);
    const before = await settings.read();
    assert.equal(before.compactionEnabled, true);
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const ask = (message: string, chatId?: string) => fetch(base + "/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, chatId }) });
    const first = await ask("Сколько людей в архиве?");
    assert.equal(first.status, 200);
    const one = await first.json();
    const second = await ask("Поставь Алексею дату рождения 1994", one.chatId);
    assert.equal(second.status, 200);
    const two = await second.json();
    assert.equal(two.suggestionIds.length, 1);
    assert.equal(bodies.length, 5);
    assert.equal(conversations, 2);
    assert.deepEqual(await app.archive.read(), baseline);
    assert.deepEqual(await settings.read(), before);
    assert.deepEqual((await app.archive.db.prepare("SELECT status FROM research_suggestions").all()).map(row => row.status), ["pending"]);
    const completedTurns = events.filter(event => event.event === "ai.turn_completed");
    assert.equal(completedTurns.length, 2);
    assert.ok(completedTurns.every(event => event.compactionEnabled === true && event.compactionAvailable === false));
    assert.equal(completedTurns[0].toolCallCount, 1);
    assert.equal(completedTurns[1].toolCallCount, 1);
  } finally {
    console.info = originalInfo;
    await app.close();
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  }
});
