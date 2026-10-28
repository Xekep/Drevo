import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recentResearchExchange, RECENT_EXCHANGE_LIMITS } from "../src/server/ai-conversation-context.ts";
import { startServer } from "../src/server/index.ts";
import type { AiChatMessage } from "../src/server/ai-chats.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string, name: string, parents: string[] = []): Person => ({
  id, name, surname: "Тест", patronymic: "", birth: "1980", birthPlace: "", sex: "u", parents, spouses: [], sources: [], generation: 1, column: 0,
});
const family: Family = { title: "Вымышленный архив", description: "", demo: false, people: [person("alex", "Алексей"), person("max", "Максим", ["alex"])], photos: [{ id: "photo", title: "Снимок", url: "/media/test.jpg", tags: [] }], links: [] };

test("recent exchange preserves the latest completed pair without modifying history or inferring its topic", () => {
  const history: AiChatMessage[] = [
    { role: "user", content: "Сколько людей всего?" }, { role: "assistant", content: "Два." },
    { role: "user", content: "Сколько детей у Алексея?" },
    { role: "user", content: "служебное уточнение выбора", hidden: true },
    { role: "assistant", content: "Один — Максим.", references: [{ kind: "person", id: "max", label: "stale name" }] },
    { role: "user", content: "Ещё не завершённый запрос" },
  ];
  const before = structuredClone(history);
  assert.deepEqual(recentResearchExchange(history, family), {
    question: { text: "Сколько детей у Алексея?", truncated: false },
    answer: { text: "Один — Максим.", truncated: false },
    references: [{ kind: "person", id: "max", label: "Тест Максим" }],
  });
  assert.deepEqual(history, before);
  assert.equal(recentResearchExchange([], family), undefined);
  assert.equal(recentResearchExchange([{ role: "assistant", content: "Нет вопроса" }], family), undefined);
});

test("recent exchange bounds quotes and references, checks current visibility and never copies arbitrary stored fields", () => {
  const refs = [null, [], { kind: "person", id: "private", label: "private" }, { kind: "photo", id: "missing", label: "missing" },
    { kind: "source", personId: "private", label: "private source" },
    { kind: "web", url: "javascript:alert(1)", label: "bad" }, { kind: "web", url: "https://name:password@example.org", label: "bad" },
    { kind: "source", personId: "max", label: "s".repeat(500), reference: "r".repeat(500), url: "javascript:bad", secret: "do not copy" },
    { kind: "photo", id: "photo", label: "old label" },
    ...Array.from({ length: 30 }, () => ({ kind: "person", id: "max", label: "old", secret: "do not copy" })),
  ];
  const result = recentResearchExchange([
    { role: "user", content: "q".repeat(10000) },
    { role: "assistant", content: "a".repeat(20000), references: refs },
  ], family)!;
  assert.equal(result.question.text.length, RECENT_EXCHANGE_LIMITS.question);
  assert.equal(result.answer.text.length, RECENT_EXCHANGE_LIMITS.answer);
  assert.equal(result.question.truncated, true);
  assert.equal(result.answer.truncated, true);
  assert.equal(result.references.length, RECENT_EXCHANGE_LIMITS.references);
  assert.equal(result.references[0].label.length, RECENT_EXCHANGE_LIMITS.label);
  assert.deepEqual(result.references[1], { kind: "photo", id: "photo", label: "Снимок" });
  assert.doesNotMatch(JSON.stringify(result), /private|missing|secret|javascript|password/);
});

for (const restore of [false, true]) test(`recent exchange reaches ${restore ? "restored" : "existing native"} conversation without rewriting or replaying current user messages`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-ai-recency-"));
  const env = { YANDEX_AI_API_KEY: "test-key", YANDEX_AI_FOLDER_ID: "folder", YANDEX_AI_MODEL: "test-model" };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const requests: Array<{ conversation: string; instructions: string; input: Array<Record<string, unknown>> }> = [];
  let conversations = 0;
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations")) return Response.json({ id: `conv-${++conversations}` });
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const call = requests.length;
    if (call === 1 || call === 3) return Response.json({ id: `tool-${call}`, status: "completed", output: [{ type: "function_call", name: "get_family", call_id: `family-${call}`, arguments: '{"personId":"alex"}' }] });
    return Response.json({ id: `answer-${call}`, status: "completed", output_text: call === 2 ? "У Алексея один ребёнок — Максим." : "Максим." });
  };
  const app = await startServer(0, join(directory, "test.sqlite"), true, undefined, fake);
  try {
    const initial = await app.archive.read();
    await app.archive.write({ ...initial.family, ...family }, initial.revision);
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const question = "Сколько детей у Алексея?";
    const ask = (message: string, chatId?: string) => fetch(base + "/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, chatId }) });
    const first = await ask(question);
    assert.equal(first.status, 200);
    const previous = await first.json();
    if (restore) await app.archive.db.prepare("UPDATE ai_chats SET yandex_conversation_id=NULL WHERE id=?").run(previous.chatId);
    const second = await ask("Покажи их список", previous.chatId);
    assert.equal(second.status, 200);
    await second.json();
    assert.equal(requests.length, 4);
    const inputTexts = requests[2].input.filter(item => item.type === "message").map(item => ({ role: item.role,
      text: (item.content as Array<{ text: string }>).map(part => part.text).join("") }));
    assert.deepEqual(inputTexts, restore ? [
      { role: "user", text: question }, { role: "assistant", text: previous.answer }, { role: "user", text: "Покажи их список" },
    ] : [{ role: "user", text: "Покажи их список" }]);
    assert.equal(conversations, restore ? 2 : 1);
    assert.equal(requests[2].conversation, restore ? "conv-2" : "conv-1");
    const marker = "Последняя завершённая пара вопрос–ответ";
    assert.ok(requests[2].instructions.includes(marker));
    assert.ok(requests[2].instructions.includes(JSON.stringify(question)));
    assert.ok(requests[2].instructions.includes(JSON.stringify(previous.answer)));
    assert.match(requests[2].instructions, /"id":"max","label":"Тест Максим"/);
    assert.ok(!requests[0].instructions.includes(marker));
    const history = await (await fetch(base + `/api/ai/chats/${previous.chatId}`)).json();
    assert.deepEqual(history.messages.filter((message: AiChatMessage) => message.role === "user").map((message: AiChatMessage) => message.content), [question, "Покажи их список"]);
    assert.equal(history.messages.length, 4);
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  }
});
