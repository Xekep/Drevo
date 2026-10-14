import { expect, test } from "@playwright/test";

test("общая навигация сохраняет сводку и ресурсы на компьютере и телефоне", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [label, route, title] of [["Сводка", "insights", "Сводка"], ["Ресурсы", "resources", "Ресурсы поиска"]]) {
      await page.goto("/tree");
      if (width < 1100) await page.getByLabel("Меню проекта", { exact: true }).click();
      const navigation = page.locator(width < 1100 ? ".nav-section-links" : ".nav-sections");
      await navigation.getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/${route}$`));
      await expect(page.locator("main h1")).toBeVisible();
      await expect(page).toHaveTitle(new RegExp(`^${title} ·`));
    }
  }
});

test("мобильное меню сначала показывает разделы и закрывается при переходе", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tree");
  const trigger = page.getByLabel("Меню проекта", { exact: true });
  await trigger.click();
  const menu = page.locator(".nav-bottom");
  await expect(menu.getByText("Разделы", { exact: true })).toBeVisible();
  await expect(menu.getByText("Аккаунт и доступ", { exact: true })).toBeVisible();
  const firstLinks = await menu.locator("a").evaluateAll((links) => links.slice(0, 3).map((link) => link.textContent?.trim()));
  expect(firstLinks).toEqual(["Древо", "Люди", "Семьи"]);
  await menu.getByRole("link", { name: "Фото", exact: true }).click();
  await expect(page).toHaveURL(/\/photos$/);
  await expect(menu).not.toBeVisible();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("действия профиля доступны в один ряд на узких экранах, меню работает с клавиатурой", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/people/e2e-child");
    const actions = page.locator(".inspector-person-actions");
    await expect(actions.getByText("Изменить", { exact: true })).toBeVisible();
    await expect(actions.getByText("Родственник", { exact: true })).toBeVisible();
    expect(await page.locator(".inspector-heading").evaluate((heading) => {
      const bounds = heading.getBoundingClientRect();
      const controls = [...heading.querySelectorAll(".inspector-person-actions > button, .person-more-actions > summary, .inspector-heading > button")]
        .map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0);
      return controls.every((rect) => rect.left >= bounds.left && rect.right <= bounds.right + 1) &&
        Math.max(...controls.map((rect) => rect.top)) - Math.min(...controls.map((rect) => rect.top)) < 2;
    }), `${width}px controls fit in a row`).toBe(true);
    const more = page.getByLabel("Другие действия с человеком", { exact: true });
    await more.focus();
    await page.keyboard.press("Enter");
    const copy = actions.getByRole("button", { name: "Скопировать ссылку", exact: true });
    await expect(copy).toBeVisible();
    expect(await copy.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return rect.left >= 0 && rect.right <= innerWidth && !!hit && element.contains(hit);
    }), `${width}px action menu stays on screen`).toBe(true);
    await page.keyboard.press("Tab");
    await expect(copy).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(copy).not.toBeVisible();
    await expect(more).toBeFocused();
    await more.click();
    await page.locator(".profile-head").click();
    await expect(copy).not.toBeVisible();
  }
});
