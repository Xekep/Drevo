import { expect, test } from "@playwright/test";
import type { ResearchCategory } from "../../src/shared/research-catalog";

test("resource directory replaces quality navigation and reads the admin catalog", async ({
  page,
  isMobile,
}, testInfo) => {
  const categoryName = `Справочник ${testInfo.project.name}`;
  const endpoint = "/api/admin/research-resources";
  const created = await page.request.post(`${endpoint}/categories`, {
    data: { name: categoryName },
    headers: { Origin: "http://127.0.0.1:4173" },
  });
  expect(created.status()).toBe(201);
  const category = (
    (await created.json()).categories as ResearchCategory[]
  ).find((item) => item.name === categoryName)!;
  const url = `https://example.org/directory-${testInfo.project.name}`;
  try {
    const added = await page.request.post(
      `${endpoint}/categories/${category.id}/resources`,
      {
        headers: { Origin: "http://127.0.0.1:4173" },
        data: {
          name: "Краеведческий справочник",
          url,
          description: "Адресные книги и школьные списки",
          enabledForAiSearch: false,
        },
      },
    );
    expect(added.status()).toBe(201);
    const resource = (
      (await added.json()).categories as ResearchCategory[]
    ).find((item) => item.id === category.id)!.resources[0];
    const apiRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/") && path.includes("research-resources"))
        apiRequests.push(`${request.method()} ${path}`);
    });
    await page.goto("/tree");
    if (isMobile) await page.getByLabel("Меню проекта").click();
    const nav = page.locator(isMobile ? ".mobile-sections" : ".nav-sections");
    await expect(
      nav.getByRole("link", { name: "Проверка", exact: true }),
    ).toHaveCount(0);
    await nav.getByRole("link", { name: "Ресурсы", exact: true }).click();
    await expect(page).toHaveURL(/\/resources$/);
    const directory = page.locator(".research-directory");
    await expect(
      directory.getByRole("heading", { name: "Ресурсы поиска" }),
    ).toBeVisible();
    await expect(
      directory.getByRole("link", { name: "Яндекс Архивы", exact: true }),
    ).toBeVisible();
    if (isMobile) await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("research-directory.png"),
    });

    const search = directory.getByRole("searchbox", { name: "Найти ресурс" });
    await search.fill("школьные");
    await directory.getByLabel("Категория").selectOption(category.id);
    const link = directory.getByRole("link", {
      name: "Краеведческий справочник",
      exact: true,
    });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", url);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(directory.getByRole("link")).toHaveCount(1);
    await expect(directory).not.toContainText("Разрешить веб-поиск ИИ");
    await expect(
      directory.getByRole("button", { name: "Изменить", exact: true }),
    ).toHaveCount(0);
    await search.fill("Несуществующий источник");
    await expect(
      directory.getByRole("heading", { name: "Ничего не найдено" }),
    ).toBeVisible();
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(link).toBeVisible();
    await search.fill("example.org");
    await expect(link).toBeVisible();
    await directory
      .getByRole("button", { name: "Очистить поиск ресурсов" })
      .click();
    await expect(search).toHaveValue("");

    // An admin edit reaches this read-only page without maintaining another list.
    const edited = await page.request.patch(
      `${endpoint}/resources/${resource.id}`,
      {
        headers: { Origin: "http://127.0.0.1:4173" },
        data: { ...resource, name: "Обновлённый справочник" },
      },
    );
    expect(edited.ok()).toBe(true);
    await page.reload();
    await directory.getByLabel("Категория").selectOption(category.id);
    await expect(
      directory.getByRole("link", { name: "Обновлённый справочник" }),
    ).toBeVisible();
    await expect(link).toHaveCount(0);
    expect(apiRequests.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(apiRequests)]).toEqual(["GET /api/research-resources"]);
  } finally {
    await page.request.delete(`${endpoint}/categories/${category.id}`, {
      headers: { Origin: "http://127.0.0.1:4173" },
    });
  }
});

test("resource directory offers retry and an empty state", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/research-resources", (route) =>
    route.fulfill(
      ++attempts === 1
        ? { status: 503, json: { error: "Unavailable" } }
        : { json: { categories: [] } },
    ),
  );
  await page.goto("/resources");
  const directory = page.locator(".research-directory");
  await expect(directory.getByRole("alert")).toContainText(
    "Не удалось загрузить справочник",
  );
  await directory.getByRole("button", { name: "Повторить" }).click();
  await expect(
    directory.getByRole("heading", { name: "Ресурсы пока не добавлены" }),
  ).toBeVisible();
  await expect(directory.getByRole("alert")).toHaveCount(0);
});
