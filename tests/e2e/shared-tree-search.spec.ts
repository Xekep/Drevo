import { expect, test } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";

test("share catalog shows the last opening and clears it after revocation", async ({
  page,
  baseURL,
}, testInfo) => {
  const title = `Ссылка для проверки посещения · ${testInfo.project.name}`;
  const archive = await (await page.request.get("/api/family")).json();
  const created = await page.request.post("/api/shares", {
    headers: {
      Origin: baseURL!,
      "If-Match": String(archive.revision),
    },
    data: {
      title,
      anchorId: "e2e-memorial-person",
      personIds: ["e2e-memorial-person"],
      durationHours: 1,
    },
  });
  expect(created.status()).toBe(201);
  const share = await created.json();
  await page.goto(share.path);
  await expect(page.locator(".tree-canvas")).toBeVisible();

  await page.goto("/manage");
  await openAdminSection(page, "shares", "Общий доступ");
  const item = page
    .locator(".share-catalog article")
    .filter({ hasText: title });
  await expect(item).toContainText("Последнее открытие:");
  await item.getByRole("button", { name: "Отозвать" }).click();
  await expect(item).toContainText("Отозвана");
  await expect(item).not.toContainText("Последнее открытие:");
});

test("shared search selects only shared people and disappears after revocation", async ({
  page,
  baseURL,
  isMobile,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (isMobile) await page.setViewportSize({ width: 320, height: 720 });
  const archive = await (await page.request.get("/api/family")).json();
  const created = await page.request.post("/api/shares", {
    headers: {
      Origin: baseURL!,
      "If-Match": String(archive.revision),
    },
    data: {
      title: "Семейная ветка с длинным названием для проверки поиска",
      anchorId: "e2e-memorial-person",
      personIds: ["e2e-memorial-person", "e2e-child"],
      durationHours: 1,
    },
  });
  expect(created.status()).toBe(201);
  const share = await created.json();
  const apiPath = share.path.replace("/s/", "/api/shared/");
  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) requests.push(`${request.method()} ${path}`);
  });
  await page.goto(share.path);
  await expect(page.locator(".tree-canvas")).toBeVisible();
  const search = page.getByRole("combobox", { name: "Найти человека" });
  const results = page.getByRole("listbox", { name: "Найденные люди" });
  const sharedHeader = page.locator(".shared-header");
  await sharedHeader.screenshot({ path: testInfo.outputPath("shared-header.png") });
  if (isMobile) {
    await expect(search).toBeHidden();
    const searchToggle = (await page.getByRole("button", { name: "Найти человека", exact: true }).boundingBox())!;
    expect(searchToggle.width).toBeGreaterThanOrEqual(44);
    expect(searchToggle.height).toBeGreaterThanOrEqual(44);
    const header = await page.locator(".shared-header").boundingBox();
    await page.getByRole("button", { name: "Найти человека", exact: true }).click();
    await expect(search).toBeFocused();
    expect((await page.locator(".shared-header").boundingBox())!.height).toBe(header!.height);
    await page.getByRole("button", { name: "Закрыть поиск человека" }).click();
    await expect(search).toBeHidden();
    await page.getByRole("button", { name: "Найти человека", exact: true }).click();
  }
  await expect(search).toBeVisible();
  if (!isMobile) {
    expect((await sharedHeader.boundingBox())!.height).toBeLessThanOrEqual(58);
    expect((await page.locator(".shared-header .archive-search").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator(".shared-search-toggle")).toBeHidden();
    await expect(page.locator(".shared-header .lucide-search:visible")).toHaveCount(1);
  }
  await search.fill("Тестов");
  await expect(results.getByRole("option")).toHaveCount(2);
  const bounds = (await results.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  expect(
    await page
      .locator(".shared-header")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await expect(page.getByTestId("rf__node-e2e-child")).toBeVisible();
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-growing|is-layout-settling/,
  );
  await page.screenshot({ path: testInfo.outputPath("shared-search.png") });

  // Елена есть в исходном архиве, но не включена в эту ссылку.
  await search.fill("Елена");
  await expect(results.getByRole("option")).toHaveCount(0);
  await expect(results).toContainText("Никого не нашли");
  await search.fill("петр 1965 Москва");
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(results).toContainText("Пётр");
  await search.press("Enter");
  await expect(results).toHaveCount(0);
  await expect(page.locator(".inspector-dock")).toContainText("Пётр");
  await expect(page).toHaveTitle(/Тестов Пётр Иванович/);
  if (isMobile) await expect(page.locator(".tree-canvas")).toHaveAttribute("inert", "");
  else await expect(page.locator(".tree-canvas")).not.toHaveAttribute("inert");
  const tabs = page.locator(".inspector-dock .panel-tabs [role=tab]");
  await expect(tabs).toHaveCount(2);
  const firstTab = (await tabs.nth(0).boundingBox())!;
  const secondTab = (await tabs.nth(1).boundingBox())!;
  expect(secondTab.x - (firstTab.x + firstTab.width)).toBeLessThan(32);
  const selected = page.getByTestId("rf__node-e2e-child");
  await expect(selected.locator(".flow-person")).toHaveClass(/is-selected/);
  await expect(selected).toBeInViewport();
  expect(new URL(page.url()).pathname).toBe(share.path);

  await search.fill("Иван Петрович");
  await results.getByRole("option").click();
  await expect(page.locator(".inspector-dock")).toContainText("Петрович");
  await page.getByRole("button", { name: "Очистить поиск" }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await search.fill("Тестов");
  await search.press("ArrowDown");
  await expect(results.getByRole("option").nth(1)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await search.press("ArrowUp");
  await expect(results.getByRole("option").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await search.press("Escape");
  await expect(search).toHaveValue("");

  await search.fill("Тестов");
  const revoked = await page.request.delete(`/api/shares/${share.share.id}`, {
    headers: { Origin: baseURL! },
  });
  expect(revoked.ok()).toBe(true);
  // Returning to the tab uses the existing access revalidation mechanism.
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByRole("heading", { name: "Ссылка недоступна" }),
  ).toBeVisible();
  await expect(search).toHaveCount(0);
  await expect(results).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).toHaveCount(0);
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(requests.every((request) => request === `GET ${apiPath}`)).toBe(true);
});

test("main tree retains the shared search component and dialog keyboard behavior", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  const search = page.getByRole("combobox", { name: "Найти человека" });
  const gear = page.getByRole("button", { name: "Настройки древа" });
  await gear.focus();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await search.fill("петр 1965");
  await search.press("Enter");
  await expect(page.locator(".inspector-dock")).toContainText("Пётр");
  await page.getByRole("button", { name: "Закрыть панель" }).click();
  await expect(page.locator(".archive-search-results")).toHaveCount(0);
  await gear.click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("/");
  await expect(search).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(search).toHaveValue("петр 1965");
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
});


test("shared mobile kinship starts as a bottom sheet and expands after choosing two people", async ({ page, baseURL, isMobile }) => {
  test.skip(!isMobile, "Bottom sheet is a mobile interaction");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const archive = await (await page.request.get("/api/family")).json();
  const response = await page.request.post("/api/shares", {
    headers: { Origin: baseURL!, "If-Match": String(archive.revision) },
    data: { title: "Проверка панели родства", anchorId: "e2e-memorial-person",
      personIds: ["e2e-memorial-person", "e2e-child"], durationHours: 1 },
  });
  expect(response.status()).toBe(201);
  const share = await response.json();
  try {
    await page.goto(share.path);
    await page.getByRole("button", { name: "Родство", exact: true }).click();
    const panel = page.locator(".inspector-dock");
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveClass(/expanded/);
    const bounds = (await panel.boundingBox())!;
    expect(bounds.y).toBeGreaterThan(page.viewportSize()!.height / 2);
    expect(bounds.y + bounds.height).toBeCloseTo(page.viewportSize()!.height, 0);
    await page.getByRole("button", { name: /^Тестов Иван Петрович,/ }).click();
    await expect(panel).not.toHaveClass(/expanded/);
    const second = page.getByRole("button", { name: /^Тестов Пётр Иванович,/ });
    const card = (await second.boundingBox())!;
    const sheet = (await panel.boundingBox())!;
    if (card.y + card.height > sheet.y) {
      await page.mouse.move(page.viewportSize()!.width / 2, sheet.y - 70);
      await page.mouse.wheel(0, card.y + card.height - sheet.y + 30);
    }
    await second.click({ timeout: 5000 });
    await expect(panel).toHaveClass(/expanded/);
  } finally {
    await page.request.delete(`/api/shares/${share.share.id}`, { headers: { Origin: baseURL! } });
  }
});
