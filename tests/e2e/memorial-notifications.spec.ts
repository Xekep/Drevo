import { test, expect } from "@playwright/test";

for (const count of [1, 0]) {
  test(`memorial section renders ${count} dates and opens the person`, async ({
    page,
  }, info) => {
    await page.route("**/api/notifications?memorial=1**", async (route) => {
      await route.fulfill({
        json: {
          items: count
            ? [
                {
                  id: "e2e-memorial-person:2020-01-01:2026-01-01",
                  personId: "e2e-memorial-person",
                  personName: "Тестов Иван Петрович",
                  date: "2026-01-01",
                  death: "2020-01-01",
                  years: 6,
                  days: 0,
                },
              ]
            : [],
        },
      });
    });
    await page.goto("/tree");
    await page.getByRole("button", { name: /^Уведомления/ }).click();
    const section = page.getByRole("region", {
      name: "Ближайшие памятные даты",
    });
    if (!count) {
      await expect(section).toHaveCount(0);
      return;
    }
    await expect(section).toContainText("Сегодня — 6 лет со дня смерти");
    await expect(section).toContainText("Сегодня день памяти");
    await page.screenshot({
      path: info.outputPath("memorial-notifications.png"),
    });
    await section.getByRole("link", { name: /Тестов Иван Петрович/ }).click();
    await expect(page).toHaveURL(/\/people\/e2e-memorial-person/);
    await expect(page.getByRole("dialog", { name: "Уведомления" })).toHaveCount(
      0,
    );
  });
}

test("a failed calendar response leaves activity notifications usable", async ({
  page,
}) => {
  await page.route("**/api/notifications?memorial=1**", (route) =>
    route.fulfill({ status: 403, json: { error: "Нет доступа" } }),
  );
  await page.goto("/tree");
  await page.getByRole("button", { name: /^Уведомления/ }).click();
  await expect(page.getByRole("dialog", { name: "Уведомления" })).toContainText(
    "Не удалось загрузить памятные даты",
  );
  await page.getByRole("button", { name: "Закрыть уведомления" }).click();
  await expect(page.getByRole("dialog", { name: "Уведомления" })).toHaveCount(
    0,
  );
});

test("living birthday has its own label, age and card link beside a memorial", async ({
  page,
}, info) => {
  await page.route("**/api/notifications?memorial=1**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "birthday",
            kind: "birthday",
            personId: "e2e-child",
            personName: "Тестов Пётр Иванович",
            date: "2026-11-07",
            birth: "1965-11-07",
            years: 61,
            days: 0,
          },
          {
            id: "memorial",
            kind: "death_anniversary",
            personId: "e2e-memorial-person",
            personName: "Тестов Иван Петрович",
            date: "2026-11-09",
            death: "2020-11-09",
            years: 6,
            days: 2,
          },
        ],
      },
    }),
  );
  await page.goto("/tree");
  if (info.project.name === "mobile")
    await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole("button", { name: /^Уведомления/ }).click();
  const section = page.getByRole("region", { name: "Ближайшие памятные даты" });
  const birthday = section.getByRole("link", { name: /Тестов Пётр Иванович/ });
  await expect(birthday).toContainText(
    "Сегодня — день рождения, исполнилось 61 год",
  );
  await expect(birthday).toContainText("Сегодня день рождения");
  await expect(birthday).not.toContainText("день памяти");
  await expect(
    section.getByRole("link", { name: /Тестов Иван Петрович/ }),
  ).toContainText("6 лет со дня смерти");
  await page.screenshot({ path: info.outputPath("birthday-notification.png") });
  await birthday.click();
  await expect(page).toHaveURL(/\/people\/e2e-child/);
});
