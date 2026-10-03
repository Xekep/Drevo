import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/index.ts";

test("an owner can name an empty tree and bind its first person to their account", async ({ page }, testInfo) => {
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
  if (testInfo.project.name === "mobile")
    await expect(page.getByRole("dialog", { name: "Новый человек" })).toBeVisible();
  await page.getByRole("textbox", { name: /ФИО/ }).fill("Анна Тестовая");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => boundPersonId).not.toBe("");
  await expect(page.getByText("Анна Тестовая").first()).toBeVisible();
  await page.getByRole("button", { name: "Изменить человека" }).click();
  if (testInfo.project.name === "mobile")
    await expect(page.getByRole("dialog", { name: "Редактировать человека" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /ФИО/ })).toBeVisible();
  if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  if (testInfo.project.name === "mobile") {
    await page.screenshot({ path: testInfo.outputPath("person-editor-320.png") });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.getByRole("textbox", { name: /ФИО/ }).fill("Анна Новая");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Анна Новая").first()).toBeVisible();
  await page.getByRole("button", { name: "Добавить родственника" }).click();
  await page.getByLabel("Кого добавить").selectOption("child");
  await page.getByRole("button", { name: "Новый человек" }).click();
  await page.getByRole("textbox", { name: /ФИО/ }).fill("Борис Тестовый");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family?.people.some((person) => person.parents.includes(boundPersonId))).toBe(true);
});

test("a two-word first-name-first entry offers an explicit swap before saving sex", async ({ page }) => {
  let family: Family | null = null;
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    family ||= { ...data.family, people: [], photos: [], links: [] };
    data.family = family;
    data.partial = false;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/family/changes", async (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    family = applyArchiveChanges(family!, changes).family;
    await route.fulfill({ json: { family, revision: 2, appliedChanges: changes } });
  });
  await page.route("**/api/users/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fulfill({ json: { user: { personId: route.request().postDataJSON().personId } } });
  });

  await page.goto("/tree");
  await page.getByRole("button", { name: "Добавить себя" }).click();
  const name = page.getByRole("textbox", { name: /ФИО/ });
  await name.fill("Щекалёв Степан");
  await expect(page.getByText("Возможно, имя и фамилия переставлены")).toBeHidden();
  await expect(page.getByLabel("Пол").locator("option:checked")).toContainText("Мужской");

  await name.fill("Степан Щекалёв");
  await expect(page.getByText("Возможно, имя и фамилия переставлены")).toBeVisible();
  await expect(page.getByLabel("Пол").locator("option:checked")).toContainText("Определить по ФИО");
  await page.getByRole("button", { name: "Поменять местами" }).click();
  await expect(name).toHaveValue("Щекалёв Степан");
  await expect(page.getByText("Возможно, имя и фамилия переставлены")).toBeHidden();
  await expect(page.getByLabel("Пол").locator("option:checked")).toContainText("Мужской");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family?.people[0]).toMatchObject({
    surname: "Щекалёв", name: "Степан", patronymic: "", sex: "m",
  });
});
