import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { viewControlArguments } from "../src/server/ai-research-support.ts";

test("view action contract rejects unknown parameters, malformed IDs and incompatible contexts", () => {
  for (const args of [null, [], { action: "delete_person" }, { action: "zoom_in", x: 42 },
    { action: "focus_people", personIds: [42] }, { action: "focus_people", personIds: Array(301).fill("a") },
    { action: "optimize_layout", goal: "tiny" }, { action: "exclude_branch", direction: "everyone" }])
    assert.throws(() => viewControlArguments(args, "tree"));
  assert.throws(() => viewControlArguments({ action: "optimize_layout" }, "gallery"), /Древо/);
  assert.throws(() => viewControlArguments({ action: "zoom_in" }, ""), /Контекст/);
});

const cases = [
  { label: "manual layout enable", message: "Дай мне самому подвигать карточки для PDF", action: { action: "enable_manual_layout" }, expected: [{ type: "manual_tree_layout", enabled: true }] },
  { label: "manual layout disable", message: "Я закончил расстановку", action: { action: "disable_manual_layout" }, expected: [{ type: "manual_tree_layout", enabled: false }] },
  { label: "manual layout unavailable in fan", message: "Дай подвигать карточки", treeMode: "fan", action: { action: "enable_manual_layout" }, expected: [] },
  { label: "natural compact", message: "Сдвинь карточки ближе друг к другу", action: { action: "optimize_layout", goal: "compact" }, expected: [{ type: "optimize_tree_layout", goal: "compact" }] },
  { label: "natural compact paraphrase", message: "Сделай древо более тесным", action: { action: "optimize_layout", goal: "compact" }, expected: [{ type: "optimize_tree_layout", goal: "compact" }] },
  { label: "natural routing", message: "Можешь рассортировать карточки для печати?", action: { action: "optimize_layout", goal: "routing" }, expected: [{ type: "optimize_tree_layout" }] },
  { label: "model default goal", message: "Упорядочь расположение", action: { action: "optimize_layout" }, expected: [{ type: "optimize_tree_layout" }] },
  { label: "negated compact", message: "Не делай древо компактнее", action: null, expected: [] },
  { label: "negated zoom", message: "Не уменьшай масштаб древа", action: null, expected: [] },
  { label: "exclude ancestors", message: "Эту персону и родителей до самого верха лучше убрать с картинки", action: { action: "exclude_branch", personId: "subject", direction: "ancestors" }, expected: [{ type: "exclude_people", personIds: ["subject", "parent"], label: "Без ветви: Тест Анна" }] },
  { label: "exclude descendants", message: "Временно спрячь её нисходящую линию", action: { action: "exclude_branch", personId: "subject", direction: "descendants" }, expected: [{ type: "exclude_people", personIds: ["subject", "child"], label: "Без ветви: Тест Анна" }] },
  { label: "criteria exclusion", message: "На картинке не нужны люди 1900 года", action: { action: "filter_by_criteria", mode: "exclude", criteria: { birthYearFrom: 1900, birthYearTo: 1900 } }, expected: [{ type: "exclude_people", personIds: ["parent"], label: "Выборка по условиям" }] },
  { label: "manual subset", message: "Ограничим картинку найденными карточками", action: { action: "filter_people", personIds: ["subject", "child"], label: "Выбранные" }, expected: [{ type: "filter_people", personIds: ["subject", "child"], label: "Выбранные" }] },
  { label: "invalid goal", message: "Измени расположение", action: { action: "optimize_layout", goal: "tiny" }, expected: [] },
  { label: "unknown person", message: "Передвинь камеру к человеку", action: { action: "focus_people", personIds: ["unavailable"] }, expected: [] },
  { label: "partial unknown focus", message: "Передвинь камеру к людям", action: { action: "focus_people", personIds: ["subject", "unavailable"] }, expected: [] },
  { label: "unknown property", message: "Сделай компактнее", action: { action: "optimize_layout", goal: "compact", width: 10 }, expected: [] },
  { label: "incompatible 3D mode", message: "Сделай компактнее", treeMode: "depth", action: { action: "optimize_layout", goal: "compact" }, expected: [] },
  { label: "incompatible fan mode", message: "Сделай компактнее", treeMode: "fan", action: { action: "optimize_layout", goal: "compact" }, expected: [] },
] as const;

for (const scenario of cases) test(`model-selected UI command: ${scenario.label}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-ai-view-"));
  const env = { YANDEX_AI_API_KEY: "test-key", YANDEX_AI_FOLDER_ID: "folder", YANDEX_AI_MODEL: "test-model" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let calls = 0;
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/conversations")) return Response.json({ id: "conv-view" });
    const body = JSON.parse(String(init?.body));
    assert.ok(body.tools.some((tool: { name: string }) => tool.name === "control_archive_view"),
      "available UI tools are independent of the request's vocabulary");
    calls++;
    return Response.json({ id: `response-${calls}`, status: "completed", output: calls === 1 && scenario.action
      ? [{ type: "function_call", call_id: "view-command", name: "control_archive_view", arguments: JSON.stringify(scenario.action) }]
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: scenario.action ? "Команда обработана." : "Понял, отображение не меняю." }] }] });
  };
  const app = await startServer(0, join(directory, "drevo.sqlite"), true, undefined, fake);
  try {
    const before = await app.archive.read();
    const template = { name: "Анна", surname: "Тест", patronymic: "", birth: "1980", birthPlace: "", sex: "u" as const, generation: 1, column: 0, sources: [] };
    await app.archive.write({ ...before.family, links: [], unions: [], photos: [], people: [
      { ...template, id: "parent", birth: "1900", parents: [], spouses: [] },
      { ...template, id: "subject", parents: ["parent"], spouses: [] },
      { ...template, id: "child", birth: "2000", parents: ["subject"], spouses: [] },
    ] }, before.revision);
    const snapshot = await app.archive.read();
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const response = await fetch(base + "/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: scenario.message, context: { view: "tree", ...("treeMode" in scenario ? { treeView: { mode: scenario.treeMode, personIds: ["subject"], filtered: false, fragment: false } } : {}) } }) });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.uiActions, scenario.expected);
    if (scenario.action && !scenario.expected.length) assert.match(data.answer, /не изменён/);
    assert.deepEqual(await app.archive.read(), snapshot, "presentation never changes family records or revision");
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  }
});
