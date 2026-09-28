import { expect, test } from "@playwright/test";

test("shared search selects only shared people and disappears after revocation", async ({
  page,
  isMobile,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (isMobile) await page.setViewportSize({ width: 320, height: 720 });
  const archive = await (await page.request.get("/api/family")).json();
  const created = await page.request.post("/api/shares", {
    headers: {
      Origin: "http://127.0.0.1:4173",
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
  const search = page.getByRole("combobox", { name: "Найти человека" });
  const results = page.getByRole("listbox", { name: "Найденные люди" });
  await expect(search).toBeVisible();
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
    headers: { Origin: "http://127.0.0.1:4173" },
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
