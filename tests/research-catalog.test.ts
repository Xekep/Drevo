import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { researchCatalogStore } from "../src/server/research-catalog.ts";
import { startServer } from "../src/server/index.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import { adaptLegacyAiFake } from "./legacy-ai-fake.ts";

test("research catalog migrates the supplied list once and limits contextual suggestions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    const catalog = researchCatalogStore(db);
    assert.equal(catalog.list().length, 8);
    assert.equal(
      catalog
        .list()
        .reduce((sum, category) => sum + category.resources.length, 0),
      63,
    );
    assert.deepEqual(
      catalog
        .search("Война", "фронтовик ВОВ")
        .resources.slice(0, 3)
        .map((item) => item.name),
      ["Память народа", "ОБД Мемориал", "Подвиг народа"],
    );
    assert.equal(
      catalog.search("Захоронения", "Свердловская область").resources.length,
      5,
    );
    assert.equal(catalog.search("Неизвестная категория").resources.length, 0);
    assert.equal(
      catalog.searchAny("дай мне цифровое кладбище режевское").resources[0]
        .name,
      "Skorbim",
    );
    initializeArchiveSchema(db);
    assert.equal(researchCatalogStore(db).list().length, 8);
  } finally {
    db.close();
  }
});

test("specific resource request returns catalog URLs and links from descriptions as Markdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-research-direct-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let providerCalls = 0;
  const app = await startServer(
    0,
    join(dir, "archive.sqlite"),
    true,
    undefined,
    adaptLegacyAiFake(async () => {
      providerCalls++;
      throw new Error(
        "A specific catalog link should not require a model call",
      );
    }),
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const catalog = researchCatalogStore(app.archive.db);
    const category = catalog
      .list()
      .find((item) => item.name === "Захоронения")!;
    catalog.createResource(
      category.id,
      {
        name: "Цифровое кладбище Режа",
        url: "https://example.org/rezh",
        description:
          "Режевского района. Карты: [[https\\://example.org/map|карта захоронений]] и [список](https://example.org/list).",
      },
      { id: "admin", name: "Администратор", role: "admin" } as ArchiveUser,
    );
    const response = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "дай мне цифровое кладбище режевское" }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(providerCalls, 0);
    assert.match(
      data.answer,
      /\[Цифровое кладбище Режа\]\(https:\/\/example\.org\/rezh\)/,
    );
    assert.match(
      data.answer,
      /\[карта захоронений\]\(https:\/\/example\.org\/map\)/,
    );
    assert.match(data.answer, /\[список\]\(https:\/\/example\.org\/list\)/);
    assert.doesNotMatch(data.answer, /\[\[http/);
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

test("admin can edit categories and resources; unsafe URLs and duplicates are rejected", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    const catalog = researchCatalogStore(db);
    const actor = {
      id: "admin",
      name: "Администратор",
      role: "admin",
    } as ArchiveUser;
    const group = catalog
      .createCategory({ name: "Местный архив" }, actor)
      .find((item) => item.name === "Местный архив")!;
    const saved = catalog.createResource(
      group.id,
      {
        name: "Областной архив",
        url: "https://example.org/search",
        description: "Метрические книги области",
      },
      actor,
    );
    const resource = saved.find((item) => item.id === group.id)!.resources[0];
    assert.ok(resource.id);
    assert.throws(
      () =>
        catalog.createResource(
          group.id,
          {
            name: "Опасная ссылка",
            url: "javascript:alert(1)",
            description: "Тест",
          },
          actor,
        ),
      /HTTP/,
    );
    assert.throws(() =>
      catalog.createResource(
        group.id,
        {
          name: "Дубль",
          url: resource.url,
          description: "Тест",
        },
        actor,
      ),
    );
    catalog.updateResource(
      resource.id,
      {
        name: "Новый архив",
        url: resource.url,
        description: "Исправленное описание",
      },
      actor,
    );
    assert.equal(
      catalog.search("Местный архив").resources[0].name,
      "Новый архив",
    );
    catalog.updateCategory(group.id, { name: "Архив области" }, actor);
    assert.equal(catalog.search("Местный архив").resources.length, 0);
    assert.equal(catalog.search("Архив области").resources.length, 1);
    catalog.deleteCategory(group.id, actor);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM research_resources WHERE id=?")
        .get(resource.id)!.n,
      0,
    );
    assert.ok(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_entries WHERE entity='research_resource'",
          )
          .get()!.n,
      ) >= 4,
    );
  } finally {
    db.close();
  }
});

test("resource administration is private and validates origin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-research-catalog-"));
  const app = await startServer(0, join(dir, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const get = await fetch(`${base}/api/admin/research-resources`);
    assert.equal(get.status, 200);
    assert.equal((await get.json()).categories.length, 8);
    const badOrigin = await fetch(
      `${base}/api/admin/research-resources/categories`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.invalid",
        },
        body: JSON.stringify({ name: "Чужая категория" }),
      },
    );
    assert.equal(badOrigin.status, 403);
    const created = await fetch(
      `${base}/api/admin/research-resources/categories`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Локальный архив" }),
      },
    );
    assert.equal(created.status, 201);
    assert.equal((await created.json()).categories.length, 9);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AI receives category names first and only five matching links after a tool call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-research-resource-ai-"));
  process.env.YANDEX_AI_API_KEY = "test-key";
  process.env.YANDEX_AI_FOLDER_ID = "folder-1";
  process.env.YANDEX_AI_MODEL = "yandexgpt/rc";
  let instructions = "";
  let selected: Array<{ name: string; url: string }> = [];
  let calls = 0;
  const aiFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ function: { name: string } }>;
    };
    calls++;
    instructions = body.messages[0].content;
    assert.ok(
      body.tools.some(
        (tool) => tool.function.name === "find_research_resources",
      ),
    );
    if (calls === 1)
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "resource-call",
                  type: "function",
                  function: {
                    name: "find_research_resources",
                    arguments: JSON.stringify({
                      category: "Война",
                      query: "фронтовик ВОВ",
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    const output = body.messages.find((item) => item.role === "tool")!;
    selected = JSON.parse(output.content).resources;
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: selected
              .slice(0, 3)
              .map((item) => `[${item.name}](${item.url})`)
              .join(", "),
          },
        },
      ],
    });
  };
  const app = await startServer(
    0,
    join(dir, "archive.sqlite"),
    true,
    undefined,
    adaptLegacyAiFake(aiFetch),
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Где искать прадеда-фронтовика?" }),
    });
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(calls, 2);
    assert.match(instructions, /Категории каталога:.*Война/);
    assert.doesNotMatch(instructions, /pamyat-naroda\.ru/);
    assert.equal(selected.length, 5);
    assert.deepEqual(
      selected.slice(0, 3).map((item) => item.name),
      ["Память народа", "ОБД Мемориал", "Подвиг народа"],
    );
    assert.match(answer.answer, /Память народа/);
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
