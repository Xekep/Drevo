import { expect, test } from "@playwright/test";

for (const gesture of ["middle", "modifier"] as const) {
  test(`native ${gesture} click opens a tab without application JavaScript`, async ({
    page,
    context,
  }) => {
    test.info().annotations.push({
      type: "issue",
      description: "https://github.com/microsoft/playwright/issues/42142",
    });
    // A pure browser default action separates tab initialization failures from
    // the application's notification, routing and read-receipt handlers.
    await context.route("**/__native-tab-probe/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: route.request().url().endsWith("/target")
          ? "<!doctype html><title>Target</title><h1>Целевая страница</h1>"
          : '<!doctype html><title>Links</title><a href="/__/__native-tab-probe/target">Открыть ссылку</a>',
      }),
    );
    await page.goto("/__/__native-tab-probe/source");
    const opened = context.waitForEvent("page");
    await page
      .getByRole("link", { name: "Открыть ссылку" })
      .click(
        gesture === "middle"
          ? { button: "middle" }
          : { modifiers: ["ControlOrMeta"] },
      );
    const target = await opened;
    try {
      await expect(target).toHaveURL(/\/__native-tab-probe\/target$/);
      await expect(target.getByRole("heading")).toHaveText("Целевая страница");
      await expect(page).toHaveURL(/\/__native-tab-probe\/source$/);
    } finally {
      await target.close();
    }
  });
}
