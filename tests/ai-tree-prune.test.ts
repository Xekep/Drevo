import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { Person } from "../src/domain/types.ts";
import { researchClock } from "../src/server/research-clock.ts";

test("AI prunes old childless people across the whole authorized tree as one reversible view action", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-ai-prune-"));
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
      return Response.json({ id: "conv-prune" });
    calls++;
    const body = JSON.parse(String(init?.body));
    const tool = body.tools.find(
      (item: { name: string }) => item.name === "control_archive_view",
    );
    assert.ok(tool.parameters.properties.criteria.properties.hasDescendants);
    assert.ok(
      tool.parameters.properties.criteria.properties.bornMoreThanYearsAgo,
    );
    return Response.json({
      id: "pruned",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "prune",
          name: "control_archive_view",
          arguments: JSON.stringify({
            action: "filter_by_criteria",
            mode: "exclude",
            criteria: { bornMoreThanYearsAgo: 80, hasDescendants: false },
            label: "Без старших ветвей без потомков",
          }),
        },
      ],
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
    const snapshot = await app.archive.read();
    const person = (id: string, overrides: Partial<Person> = {}): Person => ({
      id,
      name: id,
      surname: "Тест",
      patronymic: "",
      birth: "1900",
      birthPlace: "",
      sex: "u",
      parents: [],
      spouses: [],
      sources: [],
      generation: 1,
      column: 0,
      ...overrides,
    });
    const today = researchClock("UTC")().date;
    const exact80 = `${Number(today.slice(0, 4)) - 80}${today.slice(4)}`;
    await app.archive.write(
      {
        ...snapshot.family,
        photos: [],
        links: [],
        unions: [],
        people: [
          ...Array.from({ length: 550 }, (_, index) =>
            person(`old-leaf-${index}`, { parents: ["old-parent"] }),
          ),
          person("old-parent", { birth: "1800" }),
          person("child-parent", { birth: "1900" }),
          person("child", { birth: "2000", parents: ["child-parent"] }),
          person("unknown", { birth: "" }),
          person("exact80", { birth: exact80 }),
        ],
      },
      snapshot.revision,
    );
    const before = await app.archive.read();
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const response = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          "Убери из древа тех кто родился больше 80 лет назад и у кого нет потомков",
        context: { view: "tree", personIds: ["old-parent"], timeZone: "UTC" },
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(
      calls,
      1,
      "server confirms a standalone filter without another model synthesis",
    );
    assert.deepEqual(result.uiActions, [
      {
        type: "filter_people",
        personIds: [
          "old-parent",
          "child-parent",
          "child",
          "unknown",
          "exact80",
        ],
        label: "Без старших ветвей без потомков",
      },
    ]);
    assert.match(result.answer, /550/);
    assert.match(result.answer, /Всё древо/);
    assert.deepEqual(
      result.suggestionIds,
      [],
      "view filtering is not a deletion proposal",
    );
    assert.deepEqual(
      await app.archive.read(),
      before,
      "neither records nor revision are changed",
    );
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
