import { test, expect } from "@playwright/test";

test("VK settings form saves configuration without exposing a disabled login provider", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  let settings = {
    enabled: false,
    clientId: "",
    available: false,
    callbackUrl: "https://mydrevo.org/auth/vk/callback",
  };
  await page.route("**/api/admin/auth/vk", async (route) => {
    if (route.request().method() === "PUT") {
      const next = route.request().postDataJSON();
      expect(Object.keys(next).sort()).toEqual(["clientId", "enabled"]);
      settings = {
        ...settings,
        ...next,
        available: next.enabled && !!next.clientId,
      };
    }
    await route.fulfill({ json: settings });
  });
  await page.goto("/admin");
  await page
    .getByRole("button", { name: "Вход через VK", exact: true })
    .click();
  const form = page.getByRole("region", { name: "Настройки входа через VK" });
  await expect(
    form.getByText("https://mydrevo.org/auth/vk/callback"),
  ).toBeVisible();
  await form.getByLabel("ID приложения", { exact: true }).fill("12345678");
  await form.getByRole("checkbox", { name: "Вход через VK ID" }).check();
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText("Сохранено");
  expect(settings.available).toBe(true);
  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await form.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
  await form.screenshot({ path: info.outputPath("vk-auth-settings.png") });
  await form.getByRole("checkbox", { name: "Вход через VK ID" }).uncheck();
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText("Сохранено");
  expect(settings.available).toBe(false);
});
