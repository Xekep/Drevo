import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

test("источник дополнительной связи сохраняется отдельно от родительства", async ({ page }, info) => {
  const overviewResponse = await page.request.get("/api/family?projection=overview");
  const overview = await overviewResponse.json();
  const full = await page.request.get("/api/family").then((response) => response.json());
  let family = structuredClone(full.family) as Family;
  let revision = full.revision as number;
  family.links = [...(family.links || []), { id: "test-guardian-evidence",
    from: "e2e-child", to: "e2e-sibling", type: "guardian" as const }];
  const source = { id: `link-source-${info.project.name}`, title: "Акт об опеке",
    type: "архив", reference: "л. 4", documentIds: [] };
  await page.route("**/api/sources?*", (route) =>
    route.fulfill({ json: { sources: [source], total: 1 } }));
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ response: overviewResponse, json: { ...overview, family, revision } }));
  await page.route("**/api/family/changes", (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    const applied = applyArchiveChanges(family, changes);
    expect(applied.conflicts).toEqual([]);
    family = applied.family;
    revision++;
    return route.fulfill({ json: { family, revision, appliedChanges: changes } });
  });

  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
  const toggle = page.getByRole("button", { name: "Доп. связи" });
  if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
  const edge = page.getByRole("button", { name: "Связь: Опекун" });
  await edge.focus();
  await edge.press("Enter");
  const panel = page.locator(".connection-inspector");
  await panel.getByLabel("Статус достоверности связи").selectOption("confirmed");
  await panel.getByText("Источники связи (0)").click();
  await panel.getByRole("button", { name: "Добавить источник вручную" }).click();
  const inline = panel.locator(".union-inline-citation");
  await inline.getByLabel("Название").fill("Семейная запись");
  await inline.getByLabel("Тип").fill("рукопись");
  await inline.getByLabel("Ссылка в источнике").fill("л. 2");
  await panel.getByRole("button", { name: "Выбрать из каталога" }).click();
  await panel.getByLabel("Поиск источника").fill(source.title);
  await panel.locator(".union-catalog-results").getByRole("button", { name: new RegExp(source.title) }).click();
  await panel.getByRole("button", { name: "Сохранить связь" }).click();
  await expect.poll(() => family.links?.find((link) => link.id === "test-guardian-evidence")?.sources?.[1]?.catalogId)
    .toBe(source.id);
  expect(family.links?.find((link) => link.id === "test-guardian-evidence")?.sources?.[0].title)
    .toBe("Семейная запись");
  expect(family.links?.find((link) => link.id === "test-guardian-evidence")?.confidence)
    .toBe("confirmed");
  expect(family.people.find((person) => person.id === "e2e-sibling")?.parents)
    .not.toContain("e2e-child");
  await edge.focus();
  await edge.press("Enter");
  await panel.getByLabel("Кем приходится").selectOption("nurse");
  await expect(panel.getByText("Источники связи (0)")).toBeVisible();
  await expect(panel.getByRole("status")).toContainText("Прежняя оценка связи снята");
  await expect(panel.getByLabel("Статус достоверности связи")).toHaveCount(0);
  await panel.getByRole("button", { name: "Сохранить связь" }).click();
  await expect.poll(() => family.links?.find((link) => link.id === "test-guardian-evidence")?.type)
    .toBe("nurse");
  expect(family.links?.find((link) => link.id === "test-guardian-evidence")?.sources)
    .toBeUndefined();
  expect(family.links?.find((link) => link.id === "test-guardian-evidence")?.confidence)
    .toBeUndefined();
  const updated = page.getByRole("button", { name: "Связь: Кормилица" });
  await updated.focus();
  await updated.press("Enter");
  await panel.getByLabel("Статус достоверности связи").selectOption("probable");
  await panel.getByRole("button", { name: "Сохранить связь" }).click();
  await expect.poll(() => family.links?.find((link) => link.id === "test-guardian-evidence")?.confidence)
    .toBe("probable");
  await page.locator('.flow-person[data-person-id="e2e-sibling"] .flow-person-content').click();
  await expect(page.getByText("Оценка связи «Кормилица»: Вероятно")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
});
