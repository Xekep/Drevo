import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeResearchTool } from "../src/domain/research-tools.ts";
import { startServer } from "../src/server/index.ts";
import { newSessionToken, sessionTokenHash } from "../src/server/session-token.ts";
import type { Family, Person } from "../src/domain/types.ts";

function person(id: string, name: string, parents: string[] = [], spouses: string[] = [], sex: Person["sex"] = "m"): Person {
  return { id, surname: "Тестов", name, patronymic: "", sex, birth: "", birthPlace: "", parents, spouses, generation: 1, column: 0, sources: [] };
}
const family: Family = { title: "Вымышленный архив", description: "", demo: false, people: [
  person("grandfather", "Дед"), person("pavel", "Павел", ["grandfather"]),
  person("vladimir", "Владимир", ["grandfather"]), person("me", "Алексей", ["pavel"]),
], photos: [] };
type Relationship = { first: { id: string }; second: { id: string }; relation: { kind: string; roles: Array<{ term: string }> } };

test("typed relationship uses explicit people and both directions without language inference", () => {
  const relation = executeResearchTool(family, "get_relationship", { firstPersonId: "me", secondPersonId: "vladimir" }) as Relationship;
  assert.equal(relation.first.id, "me");
  assert.equal(relation.second.id, "vladimir");
  assert.match(relation.relation.roles[0].term, /племянник/);
  assert.match(relation.relation.roles[1].term, /дядя/);
  const parent = executeResearchTool(family, "get_relationship", { firstPersonId: "me", secondPersonId: "pavel" }) as Relationship;
  assert.match(parent.relation.roles[0].term, /сын/);
  assert.match(parent.relation.roles[1].term, /отец/);
  assert.throws(() => executeResearchTool({ ...family, people: family.people.filter(person => person.id !== "vladimir") }, "get_relationship", { firstPersonId: "me", secondPersonId: "vladimir" }));
});

test("blood and spouse paths remain available through checked tools", () => {
  const extended: Family = { ...family, people: [person("root", "Предок"),
    person("a", "Первая ветвь", ["root"]), person("b", "Вторая ветвь", ["root"]),
    person("parent-a", "Первый родитель", ["a"]), person("parent-b", "Второй родитель", ["b"]),
    person("me", "Алексей", ["parent-a"]), person("wife", "Мария", ["parent-b"], ["husband"], "f"), person("husband", "Дмитрий", [], ["wife"]),
  ] };
  const blood = executeResearchTool(extended, "get_relationship", { firstPersonId: "me", secondPersonId: "wife" }) as Relationship;
  assert.match(blood.relation.roles[1].term, /троюродная сестра/);
  const affine = executeResearchTool(extended, "get_relationship", { firstPersonId: "me", secondPersonId: "husband" }) as Relationship;
  assert.notEqual(affine.relation.kind, "unknown");
  assert.equal(affine.first.id, "me");
  assert.equal(affine.second.id, "husband");
});

test("Владимир is resolved by model tools despite selected Павел and mixed answers are not replaced by a kinship summary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-relationship-subject-"));
  const env = { PUBLIC_ORIGIN: "http://localhost", YANDEX_AI_API_KEY: "test-key", YANDEX_AI_FOLDER_ID: "folder", YANDEX_AI_MODEL: "test-model" };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let calls = 0;
  const provider: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations")) return Response.json({ id: "relationship-conversation" });
    const body = JSON.parse(String(init?.body));
    calls++;
    const tool = (name: string, args: unknown, id: string) => ({ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) });
    if (calls === 1) return Response.json({ id: "previous-person", status: "completed", output: [tool("get_person", { personId: "pavel" }, "previous-pavel")] });
    if (calls === 2) return Response.json({ id: "previous-answer", status: "completed", output_text: "Открыт [[person:pavel|Тестов Павел]]." });
    if (calls === 3) {
      assert.match(body.instructions, /personId: me/);
      assert.match(body.instructions, /Тестов Павел/);
      return Response.json({ id: "search", status: "completed", output: [tool("search_people", { query: "Владимир Тестов" }, "find-vladimir")] });
    }
    if (calls === 4) {
      const found = JSON.parse(body.input[0].output);
      assert.ok(found.people.some((person: { id: string }) => person.id === "vladimir"));
      return Response.json({ id: "checked-tools", status: "completed", output: [
        tool("get_relationship", { firstPersonId: "me", secondPersonId: "vladimir" }, "relationship"), tool("get_archive_insights", {}, "count"),
      ] });
    }
    const result = new Map(body.input.map((item: { call_id: string; output: string }) => [item.call_id, JSON.parse(item.output)]));
    const relation = result.get("relationship") as Relationship;
    const summary = result.get("count") as { totals: { people: number } };
    assert.equal(relation.second.id, "vladimir");
    return Response.json({ id: "answer", status: "completed", output_text: `Владимир — **${relation.relation.roles[1].term}**. В архиве ${summary.totals.people} человека.` });
  };
  const app = await startServer(0, join(directory, "test.sqlite"), true, undefined, provider);
  try {
    const initial = await app.archive.read();
    await app.archive.write({ ...initial.family, ...family }, initial.revision);
    await app.archive.db.prepare("INSERT INTO users(id,name,role,approved,person_id,tree_access) VALUES('requester','Пользователь','admin',1,'me','all')").run();
    const token = newSessionToken();
    await app.archive.db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(sessionTokenHash(token), "requester", Date.now() + 60000);
    const before = await app.archive.read();
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const headers = { "Content-Type": "application/json", Origin: "http://localhost", Cookie: `drevo_session=${token}` };
    const previous = await fetch(base + "/api/ai/chat", { method: "POST", headers, body: JSON.stringify({ message: "Расскажи о Павле Тестове", context: { view: "tree", openPersonId: "pavel", personIds: ["pavel"] } }) });
    assert.equal(previous.status, 200);
    const chat = await previous.json();
    const response = await fetch(base + "/api/ai/chat", { method: "POST", headers, body: JSON.stringify({ message: "Кем мне приходится Владимир Тестов? Ещё скажи, сколько людей в архиве. Не рисуй граф.", chatId: chat.chatId, context: { view: "tree", openPersonId: "pavel", personIds: ["pavel"] } }) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(calls, 5, "server must not answer an inferred relative before model tool selection");
    assert.match(result.answer, /Владимир — \*\*дядя\*\*/);
    assert.match(result.answer, /В архиве 4 человека/);
    assert.doesNotMatch(result.answer, /Павел —|отец/);
    assert.doesNotMatch(result.answer, /```mermaid/);
    assert.deepEqual(await app.archive.read(), before);
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  }
});
