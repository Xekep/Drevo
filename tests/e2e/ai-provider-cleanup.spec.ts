import { expect, test } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";
import type { AiCleanupStatus } from "../../src/shared/ai-provider-cleanup-status";

test("platform cleanup list loads lazily, paginates and shows actionable errors without overflow", async ({
  page,
}, info) => {
  const calls: URL[] = [];
  const time = new Date("2026-01-01T12:00:00Z").getTime();
  await page.route("**/api/admin/ai/cleanup?*", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const second = url.searchParams.has("cursor");
    const blocked = url.searchParams.get("filter") === "blocked";
    const body: AiCleanupStatus = {
      supported: true,
      checkedAt: time,
      counts: { binding: 1, pending: 20, leased: 1, blocked: 2 },
      jobs: [
        {
          id: second
            ? "c4030731-7619-4e23-91c3-9216a51b3773"
            : "01828202-1d55-46c5-a3b7-ef055573bf08",
          state: second || blocked ? "blocked" : "pending",
          attempts: 3,
          updatedAt: time,
          nextAttemptAt: blocked || second ? null : time + 60_000,
          error: second || blocked ? "provider_auth" : "provider_temporary",
          httpStatus: second || blocked ? 403 : 503,
        },
      ],
      nextCursor: !second && !blocked ? "next-page" : null,
    };
    await route.fulfill({ json: body });
  });
  await page.goto("/admin");
  await openAdminSection(page, "ai", "Yandex AI");
  await expect(
    page.getByText("Очистка диалогов у провайдера", { exact: true }),
  ).toBeVisible();
  expect(calls).toHaveLength(0);
  await page
    .getByText("Очистка диалогов у провайдера", { exact: true })
    .click();
  const listing = page.getByRole("region", { name: "Очередь очистки ИИ" });
  await expect(
    listing.getByText("Ожидает очистки", { exact: true }),
  ).toBeVisible();
  await expect(listing.getByText(/Временная ошибка провайдера/)).toBeVisible();
  await listing.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(listing.getByText("Страница 2", { exact: true })).toBeVisible();
  await expect(
    listing.getByText(/Проверьте права исходного подключения/),
  ).toBeVisible();
  expect(calls.at(-1)?.searchParams.get("cursor")).toBe("next-page");
  await listing.getByLabel("Показать").selectOption("blocked");
  await expect(listing.getByText("Страница 1", { exact: true })).toBeVisible();
  await expect(
    listing.getByRole("button", { name: "Далее", exact: true }),
  ).toBeDisabled();
  expect(calls.at(-1)?.searchParams.get("filter")).toBe("blocked");
  expect(calls.at(-1)?.searchParams.has("cursor")).toBe(false);
  expect(
    await listing.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await listing.screenshot({ path: info.outputPath("ai-cleanup.png") });
});
