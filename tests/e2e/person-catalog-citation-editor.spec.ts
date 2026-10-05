import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family, Source } from "../../src/domain/types.ts";

test("редактор человека показывает каталожные цитаты без ложных полей изменения", async ({ page }) => {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  let family = structuredClone(initial.family) as Family;
  let revision = initial.revision as number;
  const documentId = "11111111-1111-4111-8111-111111111111";
  const catalog: Source = {
    catalogId: "person-register", title: "Метрическая запись", type: "архив",
    reference: "Ф. 12, л. 4", note: "Оцифрованная запись",
    url: "https://archive.example/record", documentId, documentPage: 2,
  };
  const unsafe: Source = { catalogId: "legacy-unsafe", title: "Старая запись",
    type: "архив", reference: "Ф. 13", url: "javascript:alert(1)" };
  const inline: Source = { title: "Семейное письмо", type: "письмо", reference: "л. 1" };
  family = { ...family, people: family.people.map((person) => person.id === "e2e-child"
    ? { ...person, sources: [catalog, unsafe, inline] } : person) };
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ response, json: { ...initial, family, revision } }));
  await page.route("**/api/family?projection=page&*", async (route) => {
    const response = await route.fetch();
    const pageData = await response.json();
    if (route.request().url().includes("collection=people"))
      pageData.items = pageData.items.map((item: { id: string }) => item.id === "e2e-child"
        ? { ...item, sources: family.people.find((person) => person.id === item.id)!.sources }
        : item);
    await route.fulfill({ response, json: pageData });
  });
  await page.route("**/api/family/changes", (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    const applied = applyArchiveChanges(family, changes);
    expect(applied.conflicts).toEqual([]);
    family = applied.family;
    revision++;
    return route.fulfill({ json: { family, revision, appliedChanges: changes } });
  });

  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.locator(".form-details > summary").filter({ hasText: /^Источники$/ }).click();
  const sources = page.locator(".source-editor");
  await expect(sources).toHaveCount(3);
  const linked = sources.nth(0);
  await expect(linked.getByText("Метрическая запись")).toBeVisible();
  await expect(linked.getByText("Ф. 12, л. 4")).toBeVisible();
  await expect(linked.getByText("Оцифрованная запись")).toBeVisible();
  await expect(linked.locator("input, textarea, select")).toHaveCount(0);
  await expect(linked.getByRole("link", { name: "Открыть источник" }))
    .toHaveAttribute("href", catalog.url!);
  await expect(linked.getByRole("link", { name: /Открыть документ/ }))
    .toHaveAttribute("href", `/documents/${documentId}/page/2`);
  await expect(sources.nth(1).getByRole("link", { name: "Открыть источник" })).toHaveCount(0);
  await expect(sources.nth(1).locator("input, textarea, select")).toHaveCount(0);

  const manual = sources.nth(2);
  await manual.getByLabel("Название").fill("Письмо семьи");
  await manual.getByLabel("Ссылка").fill("https://example.org/letter");
  await expect(manual.getByRole("button", { name: "Добавить хранилище источника" })).toBeVisible();
  await linked.getByRole("button", { name: "Убрать источник 1" }).click();
  await expect(sources).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-child")?.sources.length).toBe(2);
  const saved = family.people.find((person) => person.id === "e2e-child")!.sources;
  expect(saved[0]).toEqual(unsafe);
  expect(saved[1]).toEqual({ ...inline, title: "Письмо семьи", url: "https://example.org/letter" });
});
