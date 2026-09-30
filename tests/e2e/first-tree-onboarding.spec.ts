import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/index.ts";

test("an owner can name an empty tree and bind its first person to their account", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Editing is currently desktop-only");
  let family: Family | null = null;
  let boundPersonId = "";
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    family ||= { ...data.family, people: [], photos: [], links: [] };
    data.family = family;
    data.partial = false;
    if (boundPersonId) data.user = { ...data.user, personId: boundPersonId };
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/family/changes", async (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    family = applyArchiveChanges(family!, changes).family;
    await route.fulfill({ json: { family, revision: 2, appliedChanges: changes } });
  });
  await page.route("**/api/users/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    boundPersonId = route.request().postDataJSON().personId;
    await route.fulfill({ json: { user: { personId: boundPersonId } } });
  });

  await page.goto("/tree");
  await page.getByRole("button", { name: "Назвать дерево" }).click();
  await expect(page.getByRole("dialog", { name: "Настройки архива" })).toBeVisible();
  await page.getByRole("textbox", { name: "Название" }).fill("История семьи Тестовых");
  await page.getByRole("button", { name: "Сохранить настройки" }).click();
  await expect.poll(() => family?.title).toBe("История семьи Тестовых");
  await page.getByRole("button", { name: "Добавить себя" }).click();
  await page.getByRole("textbox", { name: /ФИО/ }).fill("Анна Тестовая");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => boundPersonId).not.toBe("");
  await expect(page.getByText("Анна Тестовая").first()).toBeVisible();
});
