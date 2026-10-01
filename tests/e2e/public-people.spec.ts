import { expect, test } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";

test("a published card with punctuation and Unicode in its ID opens from search", async ({ page }) => {
  const personId = "family:человек.1";
  const segment = encodeURIComponent(personId);
  await page.route((url) => url.pathname === "/api/discovery/people", (route) =>
    route.fulfill({ json: { results: [{ archiveId: "tree-a", id: personId, name: "Особый Тестовый" }], nextCursor: null } }),
  );
  await page.route((url) => url.pathname === `/api/discovery/people/tree-a/${segment}`, (route) =>
    route.fulfill({ json: { person: { archiveId: "tree-a", id: personId, name: "Особый Тестовый" }, linkedCards: [] } }),
  );
  await page.goto("/discover");
  await page.getByRole("textbox", { name: "ФИО, год или место" }).fill("Особый");
  await page.getByRole("button", { name: "Найти" }).click();
  await page.getByRole("link", { name: "Особый Тестовый" }).click();
  await expect(page.locator(".public-person-card")).toContainText("Особый Тестовый");
  expect(new URL(page.url()).pathname).toBe(`/discover/person/tree-a/${segment}`);
});

test("discovery keeps same-ID cards from different archives distinct and paginates", async ({ page }) => {
  await page.route((url) => url.pathname === "/api/discovery/people", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return route.fulfill({ json: cursor
      ? { results: [{ archiveId: "tree-c", id: "same", name: "Тестов Внук" }], nextCursor: null }
      : { results: [
          { archiveId: "tree-a", id: "same", name: "Тестов Иван" },
          { archiveId: "tree-b", id: "same", name: "Тестов Павел" },
        ], nextCursor: "next" },
    });
  });
  await page.route("**/api/discovery/people/tree-b/same", (route) =>
    route.fulfill({ json: { person: { archiveId: "tree-b", id: "same", name: "Тестов Павел", birthYear: "1901" },
      linkedCards: [{ archiveId: "tree-a", id: "same", name: "Тестов Иван" }] } }),
  );
  await page.route("**/api/discovery/people/tree-a/same", (route) =>
    route.fulfill({ json: { person: { archiveId: "tree-a", id: "same", name: "Тестов Иван" },
      linkedCards: [{ archiveId: "tree-b", id: "same", name: "Тестов Павел" }] } }),
  );
  await page.goto("/discover");
  await page.getByRole("textbox", { name: "ФИО, год или место" }).fill("Тестов");
  await page.getByRole("button", { name: "Найти" }).click();
  await expect(page).toHaveURL(/\/discover\/search\//);
  await expect(page.locator(".public-person-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Показать ещё" }).click();
  await expect(page.locator(".public-person-card")).toHaveCount(3);
  await page.getByRole("link", { name: "Тестов Павел" }).click();
  await expect(page.locator(".public-person-card").first()).toContainText("1901");
  await expect(page).toHaveURL(/\/discover\/person\/tree-b\/same$/);
  await expect(page.getByRole("heading", { name: "Этот человек в других деревьях" })).toBeVisible();
  await page.getByRole("link", { name: "Тестов Иван" }).click();
  await expect(page).toHaveURL(/\/discover\/person\/tree-a\/same$/);
});

test("admin changes a card's search privacy from the eye control", async ({ page, isMobile }) => {
  test.skip(isMobile, "Публикация меняет общую тестовую базу; мобильное открытие проверяется отдельно");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  const card = page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-person");
  await card.hover();
  const privacy = card.locator(".flow-privacy");
  await expect(privacy).toBeVisible();
  await expect(privacy).toHaveAttribute("data-publication-state", "hidden");
  await privacy.click();
  const dialog = page.getByRole("dialog", { name: "Публикация человека в поиске" });
  await expect(dialog.getByRole("button", { name: "Опубликовать в поиске" })).toBeVisible();
  await expect(privacy).toHaveAttribute("data-publication-state", "hidden");
  await dialog.getByRole("checkbox", { name: /Год рождения/ }).uncheck();
  await dialog.getByRole("button", { name: "Опубликовать в поиске" }).click();
  await expect(dialog.getByRole("button", { name: "Снять с поиска" })).toBeVisible();
  await expect(privacy).toHaveAttribute("data-publication-state", "published");
  await expect(dialog.getByRole("link", { name: /\/discover\/person\// })).toHaveAttribute(
    "href", /\/discover\/person\/e2e-memorial-person$/,
  );
  await page.goto("/discover?q=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2");
  await expect(page.getByRole("heading", { name: /Тестов Иван/ })).toBeVisible();
  await expect(page.locator(".public-person-card")).not.toContainText("1940");
  await expect(page.locator(".public-person-card")).not.toContainText("биография");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  const publishedCard = page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-person");
  await publishedCard.hover();
  const publishedPrivacy = publishedCard.locator(".flow-privacy");
  await expect(publishedPrivacy).toHaveAttribute("data-publication-state", "published");
  await publishedPrivacy.click();
  await expect(publishedPrivacy).toHaveAttribute("data-publication-state", "published");
  await dialog.getByRole("button", { name: "Снять с поиска" }).click();
  await expect(dialog.getByRole("button", { name: "Опубликовать в поиске" })).toBeVisible();
  await expect(publishedPrivacy).toHaveAttribute("data-publication-state", "hidden");
});

test("privacy eye opens with one tap on mobile", async ({ page, isMobile }) => {
  test.skip(!isMobile);
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  const privacy = page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-privacy");
  await expect(privacy).toBeVisible();
  await privacy.click();
  await expect(page.getByRole("dialog", { name: "Публикация человека в поиске" })).toBeVisible();
  await expect(privacy).toHaveAttribute("data-publication-state", /hidden|published/);
});

test("admin can review and revoke a selected discovery publication", async ({ page }) => {
  let published = false;
  const reviewToken = "a".repeat(64);
  await page.route((url) => url.pathname === "/api/admin/published-people/batch/preview", (route) => {
    const body = route.request().postDataJSON();
    expect(body.personIds).toEqual(["e2e-memorial-person"]);
    return route.fulfill({ json: { revision: 7, reviewToken, people: [{
      id: "e2e-memorial-person", published,
      person: { name: "Проверено сервером", birthYear: "1940" },
    }] } });
  });
  await page.route((url) => url.pathname === "/api/admin/published-people/batch", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { fields: published ? { "e2e-memorial-person": {} } : {} } });
    expect(route.request().postDataJSON()).toMatchObject({
      personIds: ["e2e-memorial-person"], revision: 7, reviewToken,
    });
    published = route.request().method() === "POST";
    return route.fulfill({ json: { count: 1 } });
  });
  await page.goto("/admin");
  await openAdminSection(page, "publications", "Можно найти");
  await page.getByRole("searchbox", { name: "Найти человека" }).fill("Тестов Иван");
  const row = page.locator(".publication-admin-row").filter({ hasText: "Тестов Иван" });
  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Опубликовать выбранных" }).click();
  await expect(page.getByRole("region", { name: "Проверка публикации" })).toContainText("Проверено сервером");
  await page.getByRole("button", { name: "Подтвердить публикацию 1" }).click();
  await expect(page.getByRole("status")).toContainText("Опубликовано карточек: 1");
  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Снять выбранных с поиска" }).click();
  await page.getByRole("button", { name: "Подтвердить отзыв 1" }).click();
  await expect(page.getByRole("status")).toContainText("Снято с поиска: 1");
});

test("a changed archive requires a fresh server review before batch publication", async ({ page }) => {
  let previews = 0;
  await page.route((url) => url.pathname === "/api/admin/published-people/batch/preview", (route) => {
    previews += 1;
    return route.fulfill({ json: { revision: previews, reviewToken: String(previews).repeat(64),
      people: [{ id: "e2e-memorial-person", published: false,
        person: { name: "Проверено сервером" } }] } });
  });
  await page.route((url) => url.pathname === "/api/admin/published-people/batch", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { fields: {} } });
    return route.fulfill({ status: 409, json: { error: "Архив изменился; проверьте публикацию заново" } });
  });
  await page.goto("/admin");
  await openAdminSection(page, "publications", "Можно найти");
  const row = page.locator(".publication-admin-row").filter({ hasText: "Тестов Иван" });
  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Опубликовать выбранных" }).click();
  await page.getByRole("button", { name: "Подтвердить публикацию 1" }).click();
  await expect(page.getByRole("alert")).toContainText("Архив изменился");
  await expect(page.getByRole("region", { name: "Проверка публикации" })).toHaveCount(0);
  await page.getByRole("button", { name: "Опубликовать выбранных" }).click();
  await expect(page.getByRole("region", { name: "Проверка публикации" })).toContainText("Проверено сервером");
  expect(previews).toBe(2);
});

test("publication status is not reported as hidden before the server answers", async ({ page }) => {
  let releaseStatus!: () => void;
  const delayedStatus = new Promise<void>((resolve) => { releaseStatus = resolve; });
  await page.route((url) => url.pathname === "/api/admin/published-people/batch", async (route) => {
    await delayedStatus;
    await route.fulfill({ json: { fields: {} } });
  });
  try {
    await page.goto("/admin");
    await openAdminSection(page, "publications", "Можно найти");
    await page.getByRole("searchbox", { name: "Найти человека" }).fill("Тестов Иван");
    const row = page.locator(".publication-admin-row").filter({ hasText: "Тестов Иван" });
    await expect(row).toContainText("Проверяем…");
    await expect(row.getByRole("checkbox")).toBeDisabled();
    releaseStatus();
    await expect(row).toContainText("Скрыт");
    await expect(row.getByRole("checkbox")).toBeEnabled();
  } finally {
    releaseStatus();
  }
});
