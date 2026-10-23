import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

for (const scenario of ["ancestors", "descendants", "optimize", "wrong-surname", "unrequested", "generic-complement", "generic-surname", "generic-include", "self"] as const)
test(`AI view command: ${scenario}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-ai-view-"));
  const env = { YANDEX_AI_API_KEY: "test-key", YANDEX_AI_FOLDER_ID: "folder", YANDEX_AI_MODEL: "yandexgpt/rc" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let calls = 0;
  const fake: typeof fetch = async url => {
    if (String(url).endsWith("/conversations")) return Response.json({ id: "conv-view" });
    calls++;
    const action = scenario === "optimize" || scenario === "unrequested" ? { action: "optimize_layout" }
      : scenario === "wrong-surname" ? { action: "filter_surname", surname: "Кочнева" }
      : scenario === "generic-complement" ? { action: "filter_people", personIds: ["parent", "child", "other"] }
      : scenario === "generic-surname" ? { action: "filter_surname", surname: "Кочнева" }
      : scenario === "generic-include" ? { action: "filter_by_criteria", mode: "include", criteria: { surname: "Кочнева" } }
      : { action: "exclude_branch", personId: "raya", direction: scenario };
    return Response.json({ id: `response-${calls}`, status: "completed", output: calls === 1
      ? [{ type: "function_call", call_id: "view-command", name: "control_archive_view", arguments: JSON.stringify(action) }]
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Я применил фильтр по фамилии." }] }] });
  };
  const app = await startServer(0, join(directory, "drevo.sqlite"), true, undefined, fake);
  try {
    const before = await app.archive.read();
    const template = { name: "Человек", surname: "Фамилия", patronymic: "", birth: "", birthPlace: "",
      sex: "u" as const, generation: 1, column: 0, sources: [] };
    await app.archive.write({ ...before.family, links: [], unions: [], photos: [], people: [
      { ...template, id: "parent", surname: "Томилов", parents: [], spouses: [] },
      { ...template, id: "raya", name: "Раиса", surname: "Кочнева", parents: ["parent"], spouses: [] },
      { ...template, id: "child", parents: ["raya"], spouses: [] },
      { ...template, id: "other", surname: "Кочнева", parents: [], spouses: [] },
    ] }, before.revision);
    const snapshot = await app.archive.read();
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const message = scenario === "optimize" ? "Оптимизируй расположение карточек древа для печати"
      : scenario === "unrequested" ? "Сколько людей в архиве?"
      : scenario.startsWith("generic-") || scenario === "self" ? "Убери Кочневу Раю из древа"
      : `Убери Кочневу Раю вместе с ${scenario === "descendants" ? "потомками" : "предками"}`;
    const response = await fetch(base + "/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, context: { view: "tree" } }) });
    assert.equal(response.status, 200);
    const data = await response.json();
    if (scenario === "wrong-surname" || scenario === "unrequested" || scenario.startsWith("generic-")) {
      assert.deepEqual(data.uiActions, []);
      if (scenario === "wrong-surname" || scenario.startsWith("generic-")) assert.match(data.answer, /не изменён/);
    } else {
      assert.equal(calls, 1, "a verified display command requires no model synthesis");
      assert.deepEqual(data.uiActions, scenario === "optimize" ? [{ type: "optimize_tree_layout" }]
        : [{ type: "exclude_people", personIds: scenario === "self" ? ["raya"] : ["raya", scenario === "ancestors" ? "parent" : "child"], label: "Без ветви: Кочнева Раиса" }]);
      assert.doesNotMatch(data.answer, /filter_surname|exclude_branch|optimize_layout/);
    }
    assert.deepEqual(await app.archive.read(), snapshot, "commands never change family records or revision");
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  }
});
