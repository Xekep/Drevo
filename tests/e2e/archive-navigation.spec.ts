import { expect, test } from "@playwright/test";

for (const [name, path] of [
  ["Древо", "/tree"],
  ["Люди", "/people"],
  ["Семьи", "/families"],
  ["Фото", "/photos"],
  ["Документы", "/documents"],
  ["Места", "/places"],
  ["Сводка", "/insights"],
  ["Ресурсы", "/resources"],
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

test("account avatar is beside the menu and opens the personal cabinet", async ({
  page,
}, testInfo) => {
  await page.goto("/tree");
  const avatar = page.locator(".nav-account");
  const menu = page.locator(".archive-more > summary");
  await expect(avatar).toHaveAttribute("href", "/account");
  await expect(avatar).toHaveAttribute("aria-label", /Личный кабинет/);
  await expect(avatar.locator(".nav-account-avatar")).toHaveText("Н");
  const avatarBox = await avatar.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(avatarBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(avatarBox!.x + avatarBox!.width).toBeLessThan(menuBox!.x);
  if (testInfo.project.name === "mobile") {
    const search = page.locator(".archive-search");
    expect((await search.boundingBox())!.width).toBeGreaterThan(150);
    await page.setViewportSize({ width: 320, height: 640 });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
  }
  await menu.click();
  await expect(page.locator(".archive-more .nav-bottom")).not.toContainText(
    "Личный кабинет",
  );
  await page.screenshot({
    path: testInfo.outputPath("account-avatar-header.png"),
  });
  await avatar.click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(avatar).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Личный кабинет" }),
  ).toBeVisible();
});

test("account avatar uses the linked person's portrait when available", async ({
  page,
}) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = "e2e-memorial-person";
    data.family.people.find(
      (person: { id: string }) => person.id === data.user.personId,
    ).photo = "/media/nav-avatar.jpg";
    await route.fulfill({ response, json: data });
  });
  await page.route("**/media/nav-avatar.jpg?variant=thumb", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#688a70"/></svg>',
    }),
  );
  await page.goto("/tree");
  const image = page.locator(".nav-account-avatar img");
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
});
