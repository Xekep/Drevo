import { expect, test } from "@playwright/test";
import type { ArchiveNotificationsPage } from "../../src/shared/archive-notifications";

test("bell opens a compact accessible inbox, reads events and links straight to discussion", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let inbox: ArchiveNotificationsPage = {
    unread: 2,
    next: null,
    latest: 42,
    items: [
      {
        id: 42,
        at: "2026-10-11T12:00:00Z",
        kind: "person_comment",
        personId: "e2e-child",
        personName: "Тестов Потомок",
        actorName: "Другой участник",
        read: false,
      },
      {
        id: 41,
        at: "2026-10-11T11:00:00Z",
        kind: "person_added",
        personId: "e2e-memorial-person",
        personName: "Тестов Иван Петрович",
        actorName: "Другой участник",
        read: false,
      },
    ],
  };
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      inbox = {
        ...inbox,
        items: inbox.items.map((item) => ({
          ...item,
          read: item.read || body.through >= item.id || body.id === item.id,
        })),
      };
      inbox.unread = inbox.items.filter((item) => !item.read).length;
    }
    await route.fulfill({ json: inbox });
  });
  await page.goto("/tree");
  if (info.project.name === "mobile")
    await page.setViewportSize({ width: 320, height: 640 });
  const bell = page.getByRole("button", {
    name: "Уведомления: 2 непрочитанных",
  });
  await expect(bell).toBeVisible();
  const bellBounds = (await bell.boundingBox())!;
  expect(bellBounds.width).toBeGreaterThanOrEqual(44);
  await bell.click();
  const dialog = page.getByRole("dialog", { name: "Уведомления" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link")).toHaveCount(2);
  const bounds = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    )
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("notifications.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(bell).toBeFocused();
  await bell.click();
  await dialog.getByRole("button", { name: "Прочитать все" }).click();
  await expect(dialog.locator(".is-unread")).toHaveCount(0);
  const comment = dialog.getByRole("link", { name: /Тестов Потомок/ });
  await expect(comment).toHaveAttribute("href", "/people/e2e-child#discussion");
  await comment.click();
  await expect(page).toHaveURL(/\/people\/e2e-child#discussion$/);
  await expect(page.getByRole("tab", { name: "Обсуждение" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("region", { name: "Обсуждение человека" }),
  ).toBeVisible();
});
