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
          canRetry: second || blocked,
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

test("manual retry reports a queued attempt without losing the AI settings draft", async ({ page }) => {
  const id = "c4030731-7619-4e23-91c3-9216a51b3773";
  let queued = false;
  let attempts = 0;
  await page.route("**/api/admin/ai/cleanup?*", async (route) => {
    const now = Date.now();
    const body: AiCleanupStatus = {
      supported: true, checkedAt: now,
      counts: { binding: 0, pending: queued ? 1 : 0, leased: 0, blocked: queued ? 1 : 2 },
      jobs: [{ id, state: queued ? "pending" : "blocked", attempts: 2,
        updatedAt: now, nextAttemptAt: queued ? now + 45_000 : null,
        error: queued ? null : "provider_auth", httpStatus: queued ? undefined : 403,
        canRetry: !queued },
      { id: "01828202-1d55-46c5-a3b7-ef055573bf08", state: "blocked", attempts: 2,
        updatedAt: now, nextAttemptAt: null, error: "snapshot_invalid", canRetry: false }],
      nextCursor: null,
    };
    await route.fulfill({ json: body });
  });
  await page.route(`**/api/admin/ai/cleanup/${id}/retry`, async (route) => {
    attempts++;
    if (attempts < 3) {
      await route.fulfill({ status: attempts === 1 ? 409 : 503,
        json: { error: attempts === 1 ? "Задание изменилось" : "Очередь недоступна" } });
      return;
    }
    if (attempts === 3) {
      await route.abort("failed");
      return;
    }
    queued = true;
    await route.fulfill({ status: 202, json: { queued: true,
      nextAttemptAt: Date.now() + 45_000 } });
  });
  await page.goto("/admin");
  await openAdminSection(page, "ai", "Yandex AI");
  await page.getByText("Подключение Yandex, общие лимиты и контекст", { exact: true }).click();
  const folder = page.getByRole("textbox", { name: "Folder ID" });
  await folder.fill("unsaved-draft-folder");
  await page.getByText("Очистка диалогов у провайдера", { exact: true }).click();
  const listing = page.getByRole("region", { name: "Очередь очистки ИИ" });
  const retry = listing.getByRole("button", { name: "Повторить" });
  await expect(retry).toHaveCount(1);
  await retry.click();
  await expect(listing.getByRole("alert")).toContainText("Задание изменилось");
  await expect(folder).toHaveValue("unsaved-draft-folder");
  await retry.click();
  await expect(listing.getByRole("alert")).toContainText("Очередь недоступна");
  await expect(folder).toHaveValue("unsaved-draft-folder");
  await retry.click();
  await expect(listing.getByRole("alert")).toBeVisible();
  await expect(folder).toHaveValue("unsaved-draft-folder");
  await retry.click();
  await expect(listing.getByRole("status").filter({ hasText: "Поставлено в очередь" }))
    .toContainText("Удаление у провайдера ещё не подтверждено");
  await expect(retry).toHaveCount(0);
  await expect(folder).toHaveValue("unsaved-draft-folder");
  await expect(listing.getByText("Удалено", { exact: true })).toHaveCount(0);
  expect(attempts).toBe(4);
});
