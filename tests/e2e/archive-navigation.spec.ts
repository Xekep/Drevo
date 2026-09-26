import { expect, test } from "@playwright/test";

for (const [name, path] of [
  ["Древо", "/tree"],
  ["Люди", "/people"],
  ["Семьи", "/families"],
  ["Фото", "/photos"],
  ["Документы", "/documents"],
  ["Места", "/places"],
  ["Сводка", "/insights"],
]) {
  test(`middle click opens ${path} in a new tab`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await page.goto("/tree");
    await page.bringToFront();
    const sections = page.locator(".nav-sections");
    const link = sections.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", path);
    const opened = context.waitForEvent("page");
    await link.click({ button: "middle" });
    const tab = await opened;
    await expect(tab).toHaveURL(new RegExp(`${path}$`));
    await expect(page).toHaveURL(/\/tree$/);
    await tab.close();
  });
}

test("modified clicks open a tab and plain clicks retain the application", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const sections = page.locator(".nav-sections");
  const opened = context.waitForEvent("page");
  await sections
    .getByRole("link", { name: "Люди", exact: true })
    .click({ modifiers: ["ControlOrMeta"] });
  const tab = await opened;
  await expect(tab).toHaveURL(/\/people$/);
  await tab.close();
  await page.bringToFront();
  // A normal click must retain the document and the application's state.
  const documentHandle = await page.evaluateHandle(() => document);
  await sections.getByRole("link", { name: "Люди", exact: true }).click();
  await expect(page).toHaveURL(/\/people$/);
  expect(await documentHandle.evaluate((old) => old === document)).toBe(true);
});

test("mobile section links keep native addresses and close the menu on navigation", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/tree");
  await page.getByLabel("Меню проекта").click();
  const people = page
    .locator(".mobile-sections")
    .getByRole("link", { name: "Люди", exact: true });
  await expect(people).toHaveAttribute("href", "/people");
  await people.click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.locator(".archive-more")).not.toHaveAttribute("open");
});
