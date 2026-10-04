import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

test("редактор прямого родительства сохраняет цитату и оценку на существующем ребре", async ({ page }) => {
  const overviewResponse = await page.request.get("/api/family?projection=overview");
  const overview = await overviewResponse.json();
  const full = await page.request.get("/api/family").then((response) => response.json());
  let family = structuredClone(full.family) as Family;
  let revision = full.revision as number;
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
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growth-preparing|is-growing|is-layout-settling/);
  const edge = page.locator('.relationship-parent[aria-label*="Тестов Иван"][aria-label*="Тестов Пётр"]').first();
  if (test.info().project.name === "desktop") {
    const point = await edge.locator(".tree-edge-final-path").evaluate((element) => {
      const path = element as SVGPathElement;
      const local = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = local.matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
    await page.mouse.click(point.x, point.y);
  }
  else {
    await edge.focus();
    await edge.press("Enter");
  }
  const choices = page.getByRole("dialog", { name: "Связи семейной ветки" });
  const panel = page.locator(".connection-inspector");
  await expect(choices.or(panel)).toBeVisible();
  if (await choices.isVisible())
    await choices.getByRole("button", { name: /Иван[\s\S]*Пётр/ }).click();
  await expect(panel).toBeVisible();
  await panel.getByLabel("Статус достоверности связи").selectOption("probable");
  await panel.getByText("Источники связи (0)").click();
  await panel.getByRole("button", { name: "Добавить источник вручную" }).click();
  const inline = panel.locator(".union-inline-citation");
  await inline.getByLabel("Название").fill("Метрическая книга");
  await inline.getByLabel("Тип").fill("архив");
  await inline.getByLabel("Ссылка в источнике").fill("л. 7");
  await panel.getByRole("button", { name: "Сохранить связь" }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-child")
    ?.parentClaims?.find((claim) => claim.parentId === "e2e-memorial-person")?.confidence)
    .toBe("probable");
  expect(family.people.find((person) => person.id === "e2e-child")?.parents)
    .toContain("e2e-memorial-person");
  expect(family.people.find((person) => person.id === "e2e-child")?.parentClaims?.[0]
    .sources?.[0].reference).toBe("л. 7");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
  if (test.info().project.name === "desktop") {
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 40, y: 350 } });
    await page.getByRole("menuitem", { name: "Экспорт древа" }).click();
    const exportDialog = page.getByRole("dialog", { name: "Экспорт древа" });
    await exportDialog.getByRole("combobox", { name: "Формат экспорта" }).selectOption("gedcom7");
    await expect(exportDialog.getByRole("note")).toContainText("источники и оценки конкретного родительского ребра");
    await exportDialog.getByRole("combobox", { name: "Формат экспорта" }).selectOption("pdf");
    await expect(exportDialog.getByRole("note")).toHaveCount(0);
  }
});
