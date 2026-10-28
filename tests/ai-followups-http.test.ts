import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { researchFollowupMessage } from "../src/server/ai-research-followup-intent.ts";

test("steering keeps only the current task plus modifiers and drops superseded operations", () => {
  const original = "Убери Раю вместе с предками";
  assert.match(researchFollowupMessage(original, ["только её, без предков"]), /^Убери Раю/);
  assert.equal(researchFollowupMessage(original, ["нет, не скрывай, просто ответь привет"]), "нет, не скрывай, просто ответь привет");
  assert.equal(researchFollowupMessage(original, ["Покажи фотографии"]), "Покажи фотографии");
  assert.match(researchFollowupMessage(original, ["и ещё покажи фотографии"]), /^Убери Раю/);
});

for (const phase of ["response", "conversation", "recovery", "modifier", "cancel", "proposal"] as const)
test(`followup during ${phase} steers the same turn without aborting provider work`, { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-ai-steering-"));
  const env = { YANDEX_AI_API_KEY: "test-key", YANDEX_AI_FOLDER_ID: "folder", YANDEX_AI_MODEL: "model" };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: Array<{ input: Array<{ type: string; role?: string; content?: unknown; call_id?: string; output?: string }> }> = [];
  let aborted = false;
  const provider: typeof fetch = async (url, init) => {
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    const conversation = String(url).endsWith("/conversations");
    if ((phase === "conversation" && conversation) || (phase === "proposal" && !conversation && requests.length === 1) || (phase !== "conversation" && phase !== "proposal" && !conversation && !requests.length)) {
      init?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      enter();
      await gate;
    }
    if (conversation) return Response.json({ id: "steering-conversation" });
    requests.push(JSON.parse(String(init?.body)));
    if (phase === "proposal" && requests.length === 1)
      return Response.json({ id: "proposal-created", status: "completed", output: [{ type: "function_call", call_id: "proposal-create", name: "propose_person_create",
        arguments: JSON.stringify({ person: { surname: "Пупкин", name: "Вася" }, reason: "Просьба пользователя" }) }], usage: { input_tokens: 10, output_tokens: 10 } });
    if (phase === "recovery" && requests.length === 2) return Response.json({ error: { message: "Upstream unavailable" } }, { status: 502 });
    if (phase === "modifier" && requests.length === 2)
      return Response.json({ id: "refined-view", status: "completed", output: [{ type: "function_call", call_id: "refined-view", name: "control_archive_view",
        arguments: JSON.stringify({ action: "exclude_branch", personId: "raya", direction: "self" }) }], usage: { input_tokens: 10, output_tokens: 10 } });
    return Response.json({ id: `response-${requests.length}`, status: "completed", output: phase !== "conversation" && phase !== "proposal" && requests.length === 1
      ? [{ type: "function_call", call_id: "obsolete-search", name: "search_people", arguments: '{"query":"Иван"}' }]
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Привет! Уточнение учтено." }] }],
      usage: { input_tokens: 10, output_tokens: 10 } });
  };
  const app = await startServer(0, join(directory, "archive.sqlite"), true, undefined, provider);
  const control = await startServer(0, join(directory, "archive.sqlite"), true, undefined, provider);
  let final: Promise<string> | undefined;
  try {
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const controlBase = `http://127.0.0.1:${(control.server.address() as { port: number }).port}`;
    if (phase === "modifier" || phase === "cancel") {
      const initial = await app.archive.read();
      const sample = { name: "Человек", surname: "Фамилия", patronymic: "", birth: "", birthPlace: "",
        sex: "u" as const, generation: 1, column: 0, sources: [] };
      await app.archive.write({ ...initial.family, links: [], unions: [], photos: [], people: [
        { ...sample, id: "parent", parents: [], spouses: [] },
        { ...sample, id: "raya", name: "Раиса", surname: "Кочнева", patronymic: "", parents: ["parent"], spouses: [] },
      ] }, initial.revision);
    }
    const originalMessage = phase === "modifier" || phase === "cancel" ? "Убери Раю вместе с предками"
      : phase === "proposal" ? "Добавь Васю Пупкина в древо" : "Привет";
    const response = fetch(base + "/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: originalMessage, context: { view: "tree" } }) });
    final = response.then(async value => {
      const text = await value.text();
      assert.equal(value.status, 200, text);
      return text;
    });
    await entered;
    const list = await (await fetch(base + "/api/ai/chats")).json();
    const id = list.chats[0].id as string;
    const updates = phase === "conversation"
      ? ["Первое уточнение: " + "а".repeat(5900), "Второе уточнение: " + "б".repeat(5900)]
      : phase === "modifier" ? ["только её, без предков"]
      : phase === "cancel" ? ["нет, не скрывай, просто ответь привет"]
      : phase === "proposal" ? ["нет, не изменяй архив, просто ответь привет"]
      : ["Не ищи людей, просто ответь коротким приветствием."];
    for (const message of updates) {
      const requestId = randomUUID();
      const post = () => fetch(`${controlBase}/api/ai/chats/${id}/followup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, message }) });
      const accepted = await post();
      assert.equal(accepted.status, 202, await accepted.clone().text());
      const receipt = await accepted.json();
      const retry = await post();
      assert.equal(retry.status, 202);
      assert.deepEqual((await retry.json()).message, receipt.message);
    }
    const invalid = await fetch(`${base}/api/ai/chats/${id}/followup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ requestId: randomUUID(), message: "bad" }) });
    assert.equal(invalid.status, 403);
    assert.equal(aborted, false, "sending a followup must not cancel the active provider request");
    release();
    const result = JSON.parse(await final);
    assert.match(result.answer, phase === "modifier" ? /Скрою/ : /Уточнение учтено/);
    const textOf = (item: typeof requests[number]["input"][number]) => typeof item.content === "string" ? item.content
      : Array.isArray(item.content) ? item.content.map(part => (part as { text?: string }).text || "").join("") : "";
    for (const update of updates) assert.ok(requests.some(request => request.input.some(item => item.role === "user" && textOf(item) === update)), "all accepted text reaches provider without truncating earlier updates");
    if (phase !== "conversation" && phase !== "proposal") {
      assert.equal(requests.length, phase === "recovery" ? 3 : 2);
      const secondInput = requests[1].input;
      const cancellation = secondInput.findIndex(item => item.type === "function_call_output" && item.call_id === "obsolete-search");
      const clarification = secondInput.findIndex(item => item.role === "user" && textOf(item) === updates[0]);
      assert.ok(cancellation >= 0 && cancellation < clarification, "cancelled call output precedes new user input");
      assert.match(secondInput[cancellation].output!, /cancelled/);
    }
    const history = await (await fetch(`${base}/api/ai/chats/${id}`)).json();
    assert.deepEqual(history.messages.filter((item: { role: string }) => item.role === "user").map((item: { content: string }) => item.content), [originalMessage, ...updates]);
    assert.equal(history.messages.filter((item: { role: string }) => item.role === "assistant").length, 1);
    const usage = await app.archive.db.prepare("SELECT COUNT(*) AS total,SUM(provider_calls) AS calls FROM ai_usage").get();
    assert.equal(Number(usage!.total), 1, "followups use the original admitted turn and budget");
    assert.equal(Number(usage!.calls), requests.length);
    if (phase === "proposal") {
      assert.equal(requests.length, 3);
      assert.deepEqual(result.suggestionIds, [], "superseded proposal buttons do not appear in the new answer");
      assert.deepEqual(result.files, []);
      const proposal = await app.archive.db.prepare("SELECT status FROM research_suggestions").all();
      assert.deepEqual(proposal.map(item => item.status), ["pending"], "steering never applies or silently rejects a proposal");
      assert.equal((await app.archive.read()).family.people.some(person => person.name === "Вася"), false);
    }
    if (phase === "modifier") assert.deepEqual(result.uiActions[0].personIds, ["raya"], "short correction narrows the original operation to the person only");
    else assert.equal(result.uiActions.length, 0, "obsolete or explicitly cancelled tools never control the interface");
    assert.equal(aborted, false);
  } finally {
    release();
    await final;
    await control.close();
    await app.close();
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
