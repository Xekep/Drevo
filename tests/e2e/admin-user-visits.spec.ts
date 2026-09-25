import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Europe/Moscow" });
test("participants show last visit in the viewer timezone and keep unknown visits explicit", async ({
  page,
}, info) => {
  await page.route("**/api/users**", (route) =>
    route.fulfill({
      json: {
        users: [
          {
            id: "visited",
            name: "Иван Тестовый",
            role: "reader",
            approved: true,
            createdAt: "2020-01-01T00:00:00Z",
            lastVisitAt: "2026-09-26T09:34:00Z",
          },
          {
            id: "unknown",
            name: "Новый участник",
            role: "reader",
            approved: false,
            createdAt: "2020-01-01T00:00:00Z",
          },
        ],
        next: null,
        total: 2,
      },
    }),
  );
  await page.goto("/admin");
  await page.getByRole("button", { name: "Участники", exact: true }).click();
  const visited = page.getByRole("article", {
    name: "Участник: Иван Тестовый",
    exact: true,
  });
  await expect(visited.locator("time")).toHaveAttribute(
    "datetime",
    "2026-09-26T09:34:00Z",
  );
  await expect(visited.locator("time")).toContainText("26.09.2026, 12:34");
  const unknown = page.getByRole("article", {
    name: "Участник: Новый участник",
    exact: true,
  });
  await expect(unknown).toContainText("Нет данных о визите");
  await expect(unknown.locator("time")).toHaveCount(0);
  for (const width of info.project.name === "desktop"
    ? [1024, 1440]
    : [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await visited.evaluate((row) => {
      const date = row.querySelector("time")!;
      const holder = date.closest(".admin-user-identity")!;
      return {
        dateRight: date.getBoundingClientRect().right,
        holderRight: holder.getBoundingClientRect().right,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(layout.dateRight).toBeLessThanOrEqual(layout.holderRight + 1);
    expect(layout.overflow).toBeLessThanOrEqual(1);
  }
});
