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
    name: /^Уведомления(?::|$)/,
  });
  await expect(bell).toHaveAccessibleName("Уведомления: 2 непрочитанных");
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAttribute("aria-expanded", "false");
  const bellBounds = (await bell.boundingBox())!;
  expect(bellBounds.width).toBeGreaterThanOrEqual(44);
  await bell.click();
  const dialog = page.getByRole("dialog", { name: "Уведомления" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "false");
  await expect(bell).toHaveAttribute("aria-expanded", "true");
  expect(await dialog.evaluate((node) => node.tagName)).toBe("DIV");
  expect(
    await dialog.evaluate((node) => node.parentElement === document.body),
  ).toBe(true);
  await expect(page.locator(":modal")).toHaveCount(0);
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Прочитать все" }),
  ).toBeFocused();
  await dialog.focus();
  await page.keyboard.press("Shift+Tab");
  expect(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(false);
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
  await dialog.screenshot({ path: info.outputPath("notifications-panel.png") });
  await bell.click();
  await expect(dialog).not.toBeVisible();
  await bell.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(10, page.viewportSize()!.height - 10);
  await expect(dialog).not.toBeVisible();
  await expect(bell).not.toBeFocused();
  await bell.click();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(bell).toBeFocused();
  await bell.click();
  await dialog.getByRole("button", { name: "Прочитать все" }).click();
  await expect(dialog.locator(".is-unread")).toHaveCount(0);
  const comment = dialog.getByRole("link", { name: /Тестов Потомок/ });
  await expect(comment).toHaveAttribute("href", "/people/e2e-child#discussion");
  const newTab = page.context().waitForEvent("page");
  await comment.click({ button: "middle" });
  const opened = await newTab;
  await opened.waitForLoadState("domcontentloaded");
  expect(new URL(opened.url()).pathname + new URL(opened.url()).hash).toBe(
    "/people/e2e-child#discussion",
  );
  expect(new URL(page.url()).pathname).toBe("/tree");
  await opened.close();
  await expect(dialog).toBeVisible();
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

test("live polling refreshes loaded pages, preserves reading and sounds once per new batch", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-11T12:00:00Z") });
  await page.addInitScript(() => {
    const state = window as typeof window & { notificationBeeps: number };
    state.notificationBeeps = 0;
    class TestAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
      createGain() {
        return {
          connect() {},
          gain: {
            setValueAtTime() {},
            exponentialRampToValueAtTime() {},
            linearRampToValueAtTime() {},
          },
        };
      }
      createOscillator() {
        return {
          connect() {},
          frequency: { setValueAtTime() {} },
          start() {
            state.notificationBeeps++;
          },
          stop() {},
        };
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: TestAudioContext,
    });
  });
  const item = (id: number) => ({
    id,
    at: "2026-10-11T12:00:00Z",
    kind: "person_added" as const,
    personId: "e2e-child",
    personName: `Уведомление ${id}`,
    actorName: "Участник",
    read: false,
  });
  let notifications = Array.from({ length: 40 }, (_, i) => item(200 - i));
  let headLoads = 0;
  await page.route("**/api/notifications*", async (route) => {
    const before = Number(
      new URL(route.request().url()).searchParams.get("before"),
    );
    if (!before) headLoads++;
    const available = notifications.filter(
      (item) => !before || item.id < before,
    );
    const items = available.slice(0, 20);
    await route.fulfill({
      json: {
        items,
        unread: notifications.length,
        latest: notifications[0].id,
        next: available.length > items.length ? items.at(-1)!.id : null,
      },
    });
  });
  const beeps = () =>
    page.evaluate(
      () =>
        (window as typeof window & { notificationBeeps: number })
          .notificationBeeps,
    );
  await page.goto("/tree");
  if (info.project.name === "mobile")
    await page.setViewportSize({ width: 320, height: 640 });
  const bell = page.locator(".nav-notifications");
  await expect(bell).toBeVisible();
  await expect.poll(() => headLoads).toBeGreaterThanOrEqual(1);
  expect(await beeps()).toBe(0);
  const beforeClosedPoll = headLoads;
  await page.clock.fastForward(30_100);
  await expect.poll(() => headLoads).toBeGreaterThan(beforeClosedPoll);
  expect(await beeps()).toBe(0);
  await bell.click();
  const panel = page.getByRole("dialog", { name: "Уведомления" });
  await expect(panel.getByRole("link")).toHaveCount(20);
  await panel.getByRole("button", { name: "Ещё уведомления" }).click();
  await expect(panel.getByRole("link")).toHaveCount(40);
  expect(await beeps()).toBe(0);
  const list = panel.locator(".notifications-list");
  await list.evaluate((node) => {
    node.scrollTop = 120;
  });
  const readingAnchor = panel.getByRole("link", { name: /Уведомление 198\b/ });
  const readingY = (await readingAnchor.boundingBox())!.y;
  await panel
    .getByRole("button", { name: "Выключить звук уведомлений" })
    .focus();
  notifications = [
    item(202),
    item(201),
    ...notifications.filter((item) => item.id !== 170),
  ];
  await page.clock.fastForward(30_100);
  await expect(panel.getByRole("link")).toHaveCount(41);
  await expect(
    panel.getByRole("link", { name: /Уведомление 170\b/ }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("link", { name: /Уведомление 161\b/ }),
  ).toHaveCount(1);
  await expect(
    panel.getByRole("button", { name: "Ещё уведомления" }),
  ).toHaveCount(0);
  expect(
    Math.abs((await readingAnchor.boundingBox())!.y - readingY),
  ).toBeLessThan(2);
  await expect(
    panel.getByRole("button", { name: "Выключить звук уведомлений" }),
  ).toBeFocused();
  await expect.poll(beeps).toBe(1);
  await page.clock.fastForward(30_100);
  await expect.poll(beeps).toBe(1);
  await panel
    .getByRole("button", { name: "Выключить звук уведомлений" })
    .click();
  notifications = [item(203), ...notifications];
  await page.clock.fastForward(30_100);
  await expect(panel.getByRole("link")).toHaveCount(42);
  expect(await beeps()).toBe(1);
  await panel
    .getByRole("button", { name: "Включить звук уведомлений" })
    .click();
  await list.evaluate((node) => {
    node.scrollTop = 0;
  });
  notifications = [item(204), ...notifications];
  await page.clock.fastForward(30_100);
  await expect(panel.getByRole("link")).toHaveCount(43);
  await expect.poll(beeps).toBe(2);
  expect(await list.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(
    panel.getByRole("link", { name: /Уведомление 204\b/ }),
  ).toBeInViewport();
  await page.keyboard.press("Escape");
  notifications = [item(205), ...notifications];
  await page.clock.fastForward(30_100);
  await expect.poll(beeps).toBe(3);
  await expect(bell).toHaveAccessibleName(/Уведомления: 44 непрочитанных/);
});

test("revoked access stays cleared when an older poll settles after a read receipt", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-11T12:00:00Z") });
  const inbox: ArchiveNotificationsPage = {
    unread: 1,
    latest: 7,
    next: null,
    items: [
      {
        id: 7,
        at: "2026-10-11T12:00:00Z",
        kind: "person_comment",
        personId: "e2e-child",
        personName: "Доступная до отзыва карточка",
        actorName: "Участник",
        read: false,
      },
    ],
  };
  let delayed = false;
  let gets = 0;
  let pendingGets = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/notifications*", async (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({ status: 403, json: { error: "Forbidden" } });
    gets++;
    if (delayed) {
      pendingGets++;
      await pending;
    }
    await route.fulfill({ json: inbox }).catch(() => {});
  });
  await page.goto("/tree");
  const bell = page.locator(".nav-notifications");
  await expect(bell).toHaveAccessibleName("Уведомления: 1 непрочитанных");
  delayed = true;
  await bell.click();
  const panel = page.getByRole("dialog", { name: "Уведомления" });
  await expect.poll(() => pendingGets).toBeGreaterThan(0);
  const newTab = page.context().waitForEvent("page");
  await panel.getByRole("link").click({ button: "middle" });
  const opened = await newTab;
  try {
    await expect(panel.getByRole("alert")).toContainText(
      "Доступ к уведомлениям завершён",
    );
    await expect(panel.getByRole("link")).toHaveCount(0);
    release();
    await expect(panel.locator(".notifications-list")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    const beforePoll = gets;
    await page.clock.fastForward(30_100);
    await expect(panel.getByRole("alert")).toContainText(
      "Доступ к уведомлениям завершён",
    );
    await expect(panel.getByRole("link")).toHaveCount(0);
    expect(gets).toBe(beforePoll);
    await expect(bell).toHaveAccessibleName("Уведомления");
  } finally {
    release();
    await opened.close();
  }
});
