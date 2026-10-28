import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer } from "../src/server/index.ts";
import { aiSettingsStore, defaultAiRoleProfile } from "../src/server/ai-settings.ts";
import { pdfToolArguments, photoAnalysisArguments } from "../src/server/ai-research-support.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

test("PDF and photo arguments are validated independently of provider schemas", () => {
  for (const value of [null, [], {}, { title: " ", content: "body" }, { title: "t", content: " " },
    { title: "t".repeat(161), content: "body" }, { title: "t", content: "c".repeat(30001) },
    { title: "t", content: "body", includeArchiveGraph: "yes" }, { title: "t", content: "body", hidden: true }])
    assert.throws(() => pdfToolArguments(value));
  assert.deepEqual(pdfToolArguments({ title: " t ", content: " body " }), { title: "t", content: "body", includeArchiveGraph: false });
  assert.equal(pdfToolArguments({ title: "t", content: "body", includeArchiveGraph: true }).includeArchiveGraph, true);
  for (const value of [null, [], {}, { photoId: " " }, { photoId: "x".repeat(201) }, { photoId: "x\n" },
    { photoId: "photo", question: 42 }, { photoId: "photo", question: "q".repeat(2001) }, { photoId: "photo", path: "/private" }])
    assert.throws(() => photoAnalysisArguments(value));
});

type Scenario = { label: string; message: string; tool?: string; args?: Record<string, unknown>; disabled?: boolean };
const update = { personId: "alex", changes: { birth: "1987" }, reason: "Данные пользователя", evidence: ["Уточнение в текущем запросе"] };
const scenarios: Scenario[] = [
  { label: "natural proposal", message: "Поставь Алексею дату рождения 1987", tool: "propose_person_update", args: update },
  { label: "mixed request with list", message: "Дата Алексея должна быть 1987, затем покажи список изменений", tool: "propose_person_update", args: update },
  { label: "natural image question", message: "Прочти надпись на снимке", tool: "analyze_photo", args: { photoId: "photo", question: "Какая надпись видна?" } },
  { label: "natural document request", message: "Оформи результат отдельным вложением", tool: "create_pdf", args: { title: "Проверка", content: "Подтверждённые сведения." } },
  { label: "mixed source gap request", message: "Покажи пробелы в источниках и родных этого человека", tool: "get_family", args: { personId: "alex" } },
  { label: "negation", message: "Не готовь PDF и не меняй карточки, скажи привет" },
  { label: "negated export with analysis", message: "Не экспортируй древо. Скажи, сколько людей в архиве.", tool: "get_archive_insights", args: {} },
  { label: "typed GEDZIP", message: "Хочу пакет для обмена с оригиналами, именно GEDZIP", tool: "prepare_archive_export", args: { format: "gedzip7" } },
  { label: "disabled proposal forged by provider", message: "Поставь Алексею дату рождения 1987", tool: "propose_person_update", args: update, disabled: true },
  { label: "disabled vision forged by provider", message: "Прочти надпись на снимке", tool: "analyze_photo", args: { photoId: "photo" }, disabled: true },
  { label: "disabled PDF forged by provider", message: "Оформи результат отдельным вложением", tool: "create_pdf", args: { title: "Проверка", content: "Сведения." }, disabled: true },
];

for (const scenario of scenarios) test(`capability-selected tools: ${scenario.label}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-ai-capability-"));
  const env = { YANDEX_AI_API_KEY: "test-key", YANDEX_AI_FOLDER_ID: "folder", YANDEX_AI_MODEL: "test-model" };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  mkdirSync(join(directory, "uploads"));
  writeFileSync(join(directory, "uploads", "photo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  let mainCalls = 0, visionCalls = 0;
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations")) return Response.json({ id: "capability-conversation" });
    if (String(url).endsWith("/chat/completions")) {
      visionCalls++;
      assert.equal(scenario.disabled, undefined, "a disabled image capability must never send image data to the provider");
      assert.match(String(init?.body), /data:image\/jpeg;base64,/);
      return Response.json({ choices: [{ message: { content: "На снимке видна надпись." } }] });
    }
    const body = JSON.parse(String(init?.body));
    mainCalls++;
    const offered = new Set(body.tools.map((tool: { name: string }) => tool.name));
    assert.equal(offered.has("propose_person_update"), !scenario.disabled);
    assert.equal(offered.has("analyze_photo"), !scenario.disabled);
    assert.equal(offered.has("create_pdf"), !scenario.disabled);
    for (const name of ["get_family", "search_photos", "get_distribution_statistics", "prepare_archive_export"])
      assert.ok(offered.has(name), `${name} remains available for mixed and paraphrased tasks`);
    if (mainCalls === 1 && scenario.tool) return Response.json({ id: "selected-tool", status: "completed", output: [{ type: "function_call", call_id: "selected", name: scenario.tool, arguments: JSON.stringify(scenario.args) }] });
    return Response.json({ id: `reply-${mainCalls}`, status: "completed", output_text: "Привет. Задача обработана." });
  };
  const app = await startServer(0, join(directory, "test.sqlite"), true, undefined, fake);
  try {
    const initial = await app.archive.read();
    await app.archive.write({ ...initial.family, demo: false, people: [{ id: "alex", surname: "Тест", name: "Алексей", patronymic: "", sex: "m", birth: "1980", birthPlace: "", parents: [], spouses: [], sources: [], generation: 1, column: 0 }], photos: [{ id: "photo", title: "Тестовый снимок", url: "/media/photo.png", tags: [] }], links: [], unions: [] }, initial.revision);
    const settings = await aiSettingsStore(app.archive.db);
    const state = await settings.read();
    await settings.write({ ...state, roleProfiles: { admin: { ...defaultAiRoleProfile(state), photoAnalysisEnabled: !scenario.disabled, proposalsEnabled: !scenario.disabled, pdfEnabled: !scenario.disabled } } }, { id: "local", role: "admin", name: "Администратор", approved: true, createdAt: "" } as ArchiveUser);
    const snapshot = await app.archive.read();
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const response = await fetch(base + "/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: scenario.message }) });
    assert.equal(response.status, 200, await response.clone().text());
    const answer = await response.json();
    const proposal = scenario.tool === "propose_person_update" && !scenario.disabled;
    assert.equal(answer.suggestionIds.length, proposal ? 1 : 0);
    const rows = await app.archive.db.prepare("SELECT status FROM research_suggestions").all();
    assert.deepEqual(rows.map(row => row.status), proposal ? ["pending"] : []);
    assert.deepEqual(await app.archive.read(), snapshot, "model tools never apply archive changes without human confirmation");
    assert.equal(visionCalls, scenario.tool === "analyze_photo" && !scenario.disabled ? 1 : 0);
    const file = scenario.tool === "create_pdf" && !scenario.disabled;
    assert.equal(answer.files.length, file || scenario.tool === "prepare_archive_export" ? 1 : 0);
    if (file) assert.match(answer.files[0].url, /^\/api\/ai\/files\//);
    if (scenario.tool === "prepare_archive_export") assert.equal(answer.files[0].url, "/api/gedcom/export?format=gedzip7");
    assert.deepEqual(answer.uiActions, []);
    if (scenario.label === "negation") assert.equal(mainCalls, 1, "a negated PDF mention never forces a retry or a file");
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a natural edit followup can choose a proposal while the original task is running", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-ai-capability-followup-"));
  const env = { YANDEX_AI_API_KEY: "test-key", YANDEX_AI_FOLDER_ID: "folder", YANDEX_AI_MODEL: "test-model" };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations")) return Response.json({ id: "followup-conversation" });
    calls++;
    if (calls === 1) { reached(); await gate; }
    const body = JSON.parse(String(init?.body));
    assert.ok(body.tools.some((tool: { name: string }) => tool.name === "propose_person_update"));
    if (calls === 2) {
      assert.ok(body.instructions.includes("Поставь Алексею дату рождения 1987"));
      return Response.json({ id: "proposal", status: "completed", output: [{ type: "function_call", call_id: "proposal", name: "propose_person_update", arguments: JSON.stringify(update) }] });
    }
    return Response.json({ id: `reply-${calls}`, status: "completed", output_text: "Уточнение учтено." });
  };
  const app = await startServer(0, join(directory, "test.sqlite"), true, undefined, fake);
  let request: Promise<Response> | undefined;
  try {
    const initial = await app.archive.read();
    await app.archive.write({ ...initial.family, people: [{ id: "alex", surname: "Тест", name: "Алексей", patronymic: "", sex: "m", birth: "1980", birthPlace: "", parents: [], spouses: [], sources: [], generation: 1, column: 0 }] }, initial.revision);
    const snapshot = await app.archive.read();
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    request = fetch(base + "/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Поздоровайся" }) });
    await Promise.race([started, request.then(async response => { throw new Error(await response.clone().text()); })]);
    const chat = (await (await fetch(base + "/api/ai/chats")).json()).chats[0];
    const followup = await fetch(base + `/api/ai/chats/${chat.id}/followup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: randomUUID(), message: "Поставь Алексею дату рождения 1987" }) });
    assert.equal(followup.status, 202, await followup.clone().text());
    release();
    const response = await request;
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(answer.suggestionIds.length, 1);
    assert.equal(calls, 3);
    assert.deepEqual(await app.archive.read(), snapshot);
    const history = await (await fetch(base + `/api/ai/chats/${chat.id}`)).json();
    assert.deepEqual(history.messages.filter((message: { role: string }) => message.role === "user").map((message: { content: string }) => message.content), ["Поздоровайся", "Поставь Алексею дату рождения 1987"]);
  } finally {
    release();
    await request?.catch(() => {});
    await app.close();
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  }
});
