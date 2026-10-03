import { expect, test } from "@playwright/test";

test("global search is last after local people and documents and carries the query", async ({
  page,
}, info) => {
  await page.route(
    (url) => url.pathname === "/api/documents" && url.searchParams.has("q"),
    (route) =>
      route.fulfill({
        json: {
          items: [{ id: "global-search-doc", title: "Тестов документ" }],
        },
      }),
  );
  let globalQuery = "";
  await page.route(
    (url) => url.pathname === "/api/discovery/people",
    (route) => {
      globalQuery = new URL(route.request().url()).searchParams.get("q") || "";
      return route.fulfill({
        json: {
          results: [
            {
              archiveId: "another-tree",
              id: "public-person",
              name: "Тестов из другого архива",
            },
          ],
          nextCursor: null,
        },
      });
    },
  );
  await page.goto("/tree");
  const input = page.getByRole("combobox", {
    name: "Найти человека или документ",
  });
  await input.fill("Тестов");
  const results = page.getByRole("listbox", {
    name: "Найденные люди и документы",
  });
  await expect(
    results.getByRole("option", { name: /Тестов документ/ }),
  ).toBeVisible();
  const global = results.getByRole("option", { name: /Глобальный поиск/ });
  await expect(results.getByRole("option").last()).toContainText(
    "Глобальный поиск",
  );
  await expect(global).toHaveAttribute(
    "href",
    "/discover/search/" + encodeURIComponent("Тестов"),
  );
  await expect(global).toContainText("Опубликованные люди всех архивов");
  await expect(global).toBeInViewport();
  const box = (await results.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: info.outputPath("global-search.png") });
  await global.click();
  await expect(
    page.getByRole("textbox", { name: "ФИО, год или место" }),
  ).toHaveValue("Тестов");
  await expect(
    page.getByRole("heading", { name: "Тестов из другого архива" }),
  ).toBeVisible();
  expect(globalQuery).toBe("Тестов");
});

test("global search opens with an empty input and supports keyboard navigation and Escape", async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === "/api/documents" && url.searchParams.has("q"),
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    (url) => url.pathname === "/api/discovery/people",
    (route) => route.fulfill({ json: { results: [], nextCursor: null } }),
  );
  await page.goto("/tree");
  const input = page.getByRole("combobox", {
    name: "Найти человека или документ",
  });
  const results = page.getByRole("listbox", {
    name: "Найденные люди и документы",
  });
  await input.focus();
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(results.getByRole("option")).toHaveAttribute(
    "href",
    "/discover",
  );
  await input.press("Escape");
  await expect(results).toHaveCount(0);
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await input.fill("И".repeat(99) + "😀");
  await expect(results.getByRole("option")).toHaveAttribute(
    "href",
    "/discover/search/" + encodeURIComponent("И".repeat(99)),
  );
  await input.fill("Неттакогочеловека");
  await expect(results).toContainText("Ничего не нашли");
  await input.press("ArrowUp");
  await expect(results.getByRole("option")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await input.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "ФИО, год или место" }),
  ).toHaveValue("Неттакогочеловека");
});

test("global search retains native middle-click navigation", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.goto("/tree");
  await page
    .getByRole("combobox", { name: "Найти человека или документ" })
    .focus();
  const opened = context.waitForEvent("page");
  await page
    .getByRole("option", { name: /Глобальный поиск/ })
    .click({ button: "middle" });
  const tab = await opened;
  await expect(tab).toHaveURL(/\/discover$/);
  await expect(page).toHaveURL(/\/tree$/);
  await tab.close();
});

test("a selected global search stays selected when document results arrive", async ({
  page,
}) => {
  let release!: () => void;
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/documents" && url.searchParams.has("q"),
    async (route) => {
      requested();
      await pending;
      await route.fulfill({
        json: { items: [{ id: "late", title: "Тестов поздний документ" }] },
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/discovery/people",
    (route) => route.fulfill({ json: { results: [], nextCursor: null } }),
  );
  await page.goto("/tree");
  const input = page.getByRole("combobox", {
    name: "Найти человека или документ",
  });
  await input.fill("Тестов");
  await seen;
  await input.press("ArrowUp");
  const results = page.getByRole("listbox", {
    name: "Найденные люди и документы",
  });
  await expect(results.getByRole("option").last()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  release();
  await expect(
    results.getByRole("option", { name: /поздний документ/ }),
  ).toBeVisible();
  await expect(results.getByRole("option").last()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await input.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "ФИО, год или место" }),
  ).toHaveValue("Тестов");
});
