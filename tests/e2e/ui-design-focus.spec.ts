import { expect, test, type Page } from "@playwright/test";

async function keyboardActivate(page: Page, target: ReturnType<Page["locator"]>) {
  await target.focus();
  await page.keyboard.press("Enter");
}

async function openEmptyTree(page: Page) {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch(), data = await response.json();
    data.family = { ...data.family, people: [], links: [], unions: [], photos: [] };
    data.partial = false;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  return page.getByRole("button", { name: "Добавить первого человека", exact: true });
}

test("явная клавиатурная навигация переводит фокус в новый каталог", async ({ page }, info) => {
  await page.goto("/tree");
  if (info.project.name === "mobile")
    await keyboardActivate(page, page.getByLabel("Меню проекта"));
  const people = page.locator(info.project.name === "mobile" ? ".mobile-sections" : ".nav-sections")
    .getByRole("link", { name: "Люди", exact: true });
  await keyboardActivate(page, people);
  const heading = page.locator(".people-directory h1");
  await expect(heading).toBeFocused();
  await expect(page.locator(".archive-more")).not.toHaveAttribute("open");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Порядок", exact: true })).toBeFocused();
});

test("создание получает статический заголовок и Tab остаётся в форме", async ({ page }) => {
  const add = await openEmptyTree(page);
  await keyboardActivate(page, add);
  await expect(page.locator(".inline-editor h2")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Закрыть редактор", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  const name = page.locator('.person-editor-form input[data-field="name"]');
  await expect(name).toBeFocused();
  await page.keyboard.type("Клавиатурный Тест");
  await expect(name).toBeFocused();
  await page.getByRole("button", { name: "Закрыть редактор", exact: true }).focus();
  page.once("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("Enter");
  await expect(page.locator(".inline-editor")).toHaveCount(0);
  await expect(add).toBeFocused();
});

test("редактирование возвращает фокус к заменённому инициатору", async ({ page }) => {
  await page.goto("/people/e2e-child");
  const edit = page.getByRole("button", { name: "Изменить человека", exact: true });
  await keyboardActivate(page, edit);
  await expect(page.locator(".inline-editor h2")).toBeFocused();
  await keyboardActivate(page, page.getByRole("button", { name: "Закрыть редактор", exact: true }));
  await expect(edit).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /^(Добавить в закладки|Удалить из закладок)$/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Добавить родственника", exact: true })).toBeFocused();
});

test("поздний lazy редактор сохраняет выбранный пользователем фокус", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/archive-editors-content[^/]*\.(?:tsx|js)(?:\?|$)/, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    const add = await openEmptyTree(page);
    await keyboardActivate(page, add);
    await expect(page.getByText("Открываем редактор…", { exact: true })).toBeVisible();
    const search = page.locator(".archive-search input");
    await search.focus();
    await page.keyboard.type("Пётр");
    release();
    await expect(page.locator(".inline-editor")).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("Пётр");
  } finally {
    release();
  }
});

test("поздний каталог не перехватывает ввод после явной навигации", async ({ page }, info) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/people-catalog[^/]*\.(?:tsx|js)(?:\?|$)/, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/tree");
    if (info.project.name === "mobile")
      await keyboardActivate(page, page.getByLabel("Меню проекта"));
    const people = page.locator(info.project.name === "mobile" ? ".mobile-sections" : ".nav-sections")
      .getByRole("link", { name: "Люди", exact: true });
    await keyboardActivate(page, people);
    await expect(page).toHaveURL(/\/people$/);
    const search = page.locator(".archive-search input");
    await search.focus();
    await page.keyboard.type("Иван");
    release();
    await expect(page.locator(".people-directory h1")).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("Иван");
  } finally {
    release();
  }
});

test("фоновая догрузка сведений сохраняет фокус поля редактора", async ({ page }, info) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let pending = false;
  await page.route("**/api/family?projection=timeline&**", async (route) => {
    pending = true;
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/people/e2e-child");
    const edit = page.getByRole("button", { name: "Изменить человека", exact: true });
    await expect(edit).toBeVisible();
    if (info.project.name === "mobile")
      await page.getByRole("button", { name: "Свернуть панель", exact: true }).click();
    await (info.project.name === "mobile"
      ? page.getByRole("switch", { name: "Древо / Хронология", exact: true })
      : page.getByRole("button", { name: "Хронология", exact: true })).click();
    await expect.poll(() => pending).toBe(true);
    if (info.project.name === "mobile")
      await page.getByRole("button", { name: "Развернуть панель", exact: true }).click();
    await keyboardActivate(page, edit);
    const name = page.locator('.person-editor-form input[data-field="name"]');
    await name.focus();
    await page.keyboard.type(" тест");
    const reply = page.waitForResponse((response) => response.url().includes("projection=timeline"));
    release();
    await reply;
    await expect(name).toBeFocused();
    await expect(name).toHaveValue(/тест/);
    await expect(page.locator(".inspector-dock")).not.toHaveAttribute("aria-modal");
  } finally {
    release();
  }
});
