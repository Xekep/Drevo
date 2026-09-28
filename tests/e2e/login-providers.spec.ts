import { expect, test } from "@playwright/test";

for (const path of ["/tree", "/account"])
  for (const provider of ["vk", "yandex"] as const)
    test(`${path} offers logo login through ${provider} without a header login button`, async ({
      page,
    }, testInfo) => {
      await page.route("**/api/family?projection=overview", (route) =>
        route.fulfill({ status: 401, json: { error: "Войдите в архив" } }),
      );
      await page.route("**/api/session", (route) =>
        route.fulfill({
          json: {
            user: null,
            local: false,
            canEdit: false,
            vk: true,
            yandex: true,
          },
        }),
      );
      await page.route(`**/auth/${provider}`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<p>OAuth started</p>",
        }),
      );
      await page.goto(path);
      const group = page.getByRole("group", { name: "Способ входа" });
      await expect(group.getByRole("button")).toHaveCount(2);
      await expect(
        group.getByRole("button", { name: "Войти через VK", exact: true }),
      ).toBeEnabled();
      await expect(
        group.getByRole("button", { name: "Войти через Яндекс", exact: true }),
      ).toBeEnabled();
      await expect(
        page.locator(".archive-header").getByRole("button", { name: /Войти/ }),
      ).toHaveCount(0);
      const box = await group.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        page.viewportSize()!.width,
      );
      if (provider === "vk")
        await page.screenshot({ path: testInfo.outputPath("login-logos.png") });
      await group
        .getByRole("button", {
          name: `Войти через ${provider === "vk" ? "VK" : "Яндекс"}`,
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(new RegExp(`/auth/${provider}$`));
    });

test("unconfigured VK has no icon or unavailable-provider notice", async ({
  page,
}) => {
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: { user: null, local: false, vk: false, yandex: true },
    }),
  );
  await page.goto("/tree");
  await expect(
    page.getByRole("button", { name: "Войти через VK", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Войти через Яндекс", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("Вход через VK пока недоступен.", { exact: true }),
  ).toHaveCount(0);
});
