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

test("an open public card rechecks revoked links and publication on focus", async ({ page }) => {
  let state: "linked" | "delayed-linked" | "revoked" | "unpublished" = "linked";
  let signalDelayed!: () => void;
  const delayedSeen = new Promise<void>((resolve) => { signalDelayed = resolve; });
  let releaseDelayed!: () => void;
  const delayedRelease = new Promise<void>((resolve) => { releaseDelayed = resolve; });
  let signalDelayedDone!: () => void;
  const delayedDone = new Promise<void>((resolve) => { signalDelayedDone = resolve; });
  await page.route("**/api/discovery/people/tree-a/root", async (route) => {
    const current = state;
    if (current === "delayed-linked") {
      signalDelayed();
      await delayedRelease;
    }
    try {
      if (current === "unpublished")
        await route.fulfill({ status: 404, json: { error: "Карточка недоступна" } });
      else await route.fulfill({ json: {
        person: { archiveId: "tree-a", id: "root", name: "Public Root" },
        linkedCards: current === "linked" || current === "delayed-linked"
          ? [{ archiveId: "tree-b", id: "other", name: "Former Link" }] : [],
      } });
    } finally {
      if (current === "delayed-linked") signalDelayedDone();
    }
  });
  try {
    await page.goto("/discover/person/tree-a/root");
    await expect(page.getByRole("link", { name: "Former Link" })).toBeVisible();

    state = "delayed-linked";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await delayedSeen;
    state = "revoked";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("heading", { name: "Public Root" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Former Link" })).toHaveCount(0);
    releaseDelayed();
    await delayedDone;
    await expect(page.getByRole("link", { name: "Former Link" })).toHaveCount(0);

    state = "unpublished";
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("heading", { name: "Public Root" })).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("Карточка недоступна");
  } finally {
    releaseDelayed();
  }
});

test("an open discovery search drops withdrawn results and restarts pagination on focus", async ({ page }) => {
  let withdrawn = false;
  let delayOldPage = false;
  let signalOldPage!: () => void;
  const oldPageSeen = new Promise<void>((resolve) => { signalOldPage = resolve; });
  let releaseOldPage!: () => void;
  const oldPageRelease = new Promise<void>((resolve) => { releaseOldPage = resolve; });
  let signalOldPageDone!: () => void;
  const oldPageDone = new Promise<void>((resolve) => { signalOldPageDone = resolve; });
  const cursors: string[] = [];
  await page.route((url) => url.pathname === "/api/discovery/people", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor") || "";
    cursors.push(cursor);
    if (cursor === "old-page" && delayOldPage) {
      signalOldPage();
      await oldPageRelease;
    }
    try {
      await route.fulfill({ json: cursor === "old-page"
        ? { results: [{ archiveId: "tree-a", id: "withdrawn", name: "Former Card" }], nextCursor: null }
        : cursor === "new-page"
          ? { results: [{ archiveId: "tree-b", id: "later", name: "Later Card" }], nextCursor: null }
          : withdrawn
            ? { results: [{ archiveId: "tree-b", id: "survivor", name: "Surviving Card" }], nextCursor: "new-page" }
            : { results: [
                { archiveId: "tree-a", id: "withdrawn", name: "Former Card" },
                { archiveId: "tree-b", id: "survivor", name: "Surviving Card" },
              ], nextCursor: "old-page" } });
    } finally {
      if (cursor === "old-page" && delayOldPage) signalOldPageDone();
    }
  });
  try {
    await page.goto("/discover/search/Tester");
    await expect(page.getByRole("link", { name: "Former Card" })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveValue("Tester");
    delayOldPage = true;
    await page.getByRole("button", { name: "Показать ещё" }).click();
    await oldPageSeen;

    withdrawn = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("link", { name: "Former Card" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Surviving Card" })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveValue("Tester");
    releaseOldPage();
    await oldPageDone;
    await expect(page.getByRole("link", { name: "Former Card" })).toHaveCount(0);

    await page.getByRole("button", { name: "Показать ещё" }).click();
    await expect(page.getByRole("link", { name: "Later Card" })).toBeVisible();
    expect(cursors).toContain("old-page");
    expect(cursors).toContain("new-page");
  } finally {
    releaseOldPage();
  }
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

test("owner opts one already published close relation into matching and can revoke it", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop publication dialog covers relation consent");
  let enabled = false;
  const path = "/api/discovery/matches/relative-consents";
  await page.route((url) => url.pathname === "/api/admin/published-people/e2e-memorial-person",
    (route) => route.fulfill({ json: { archiveId: "tree-a", published: true, publishable: true,
      fields: { birthSurname: false, birthYear: false, deathYear: false,
        birthPlace: false, deathPlace: false }, person: { name: "Тестов Иван" } } }));
  await page.route((url) => url.pathname === path, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body).toMatchObject({ personId: "e2e-memorial-person", relationId: "parent-link" });
      enabled = body.enabled;
      return route.fulfill({ json: { saved: true } });
    }
    return route.fulfill({ json: { relatives: [{ relationId: "parent-link", personId: "parent",
      name: "Тестова Мария", kind: "parent", enabled }] } });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  const card = page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-person");
  await card.hover();
  await card.locator(".flow-privacy").click();
  const checkbox = page.getByRole("dialog", { name: "Публикация человека в поиске" })
    .getByRole("checkbox", { name: "Родитель: Тестова Мария" });
  await expect(checkbox).not.toBeChecked();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await checkbox.click();
  await expect(checkbox).not.toBeChecked();
  expect(enabled).toBe(false);
});

test("a SQLite publication does not request PostgreSQL-only relative consent", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop publication dialog covers the SQLite boundary");
  let relativeRequests = 0;
  await page.route((url) => url.pathname === "/api/discovery/matches/relative-consents", (route) => {
    relativeRequests++;
    return route.fulfill({ status: 501, json: { error: "PostgreSQL required" } });
  });
  await page.route((url) => url.pathname === "/api/admin/published-people/e2e-memorial-person",
    (route) => route.fulfill({ json: { archiveId: null, published: true, publishable: true,
      fields: { birthSurname: false, birthYear: false, deathYear: false,
        birthPlace: false, deathPlace: false }, person: { name: "Тестов Иван" } } }));
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  const card = page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-person");
  await card.hover();
  await card.locator(".flow-privacy").click();
  const dialog = page.getByRole("dialog", { name: "Публикация человека в поиске" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(relativeRequests).toBe(0);
});

test("a saved publication change asks for refresh when access changes before reply", async ({ page, isMobile }) => {
  test.skip(isMobile, "The desktop privacy dialog covers this response contract");
  const path = "/api/admin/published-people/e2e-memorial-person";
  let writes = 0;
  await page.route((url) => url.pathname === path, (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      return route.fulfill({ json: { saved: true, refreshRequired: true } });
    }
    return route.fulfill({ json: {
      published: false, publishable: true, fields: {
        birthSurname: false, birthYear: false, deathYear: false,
        birthPlace: false, deathPlace: false,
      }, person: { name: "Тестов Иван" },
    } });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  const card = page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-person");
  await card.hover();
  await card.locator(".flow-privacy").click();
  const dialog = page.getByRole("dialog", { name: "Публикация человека в поиске" });
  await dialog.getByRole("button", { name: "Опубликовать в поиске" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Изменение сохранено");
  await expect(dialog.getByRole("button", { name: "Опубликовать в поиске" })).toHaveCount(0);
  expect(writes).toBe(1);
});

test("publication admin refreshes an automatically revoked status on focus", async ({ page }) => {
  let published = true;
  await page.route((url) => url.pathname === "/api/admin/published-people/batch", (route) =>
    route.fulfill({ json: { fields: published ? { "e2e-memorial-person": {} } : {} } }));
  await page.goto("/admin");
  await openAdminSection(page, "publications", "Можно найти");
  await page.getByRole("searchbox", { name: "Найти человека" }).fill("Тестов Иван");
  const row = page.locator(".publication-admin-row").filter({ hasText: "Тестов Иван" });
  await expect(row.locator(".publication-admin-state")).toHaveText("Можно найти");
  published = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(row.locator(".publication-admin-state")).toHaveText("Скрыт");
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

test("invited admin sees owner-only publication explanation without forbidden controls", async ({ page }) => {
  let forbiddenCalls = 0;
  await page.route((url) => url.pathname === "/api/family" && url.searchParams.get("projection") === "overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    return route.fulfill({ response, json: { ...data, local: false } });
  });
  await page.route((url) => url.pathname === "/api/account/archives", (route) =>
    route.fulfill({ json: { archives: [{ id: "invited-tree", title: "Чужое дерево",
      role: "admin", approved: true, owned: false, current: true }] } }));
  await page.route((url) => url.pathname.startsWith("/api/admin/published-people/"), (route) => {
    forbiddenCalls += 1;
    return route.fulfill({ status: 403, json: { error: "Публикация доступна владельцу дерева" } });
  });

  await page.goto("/admin");
  await openAdminSection(page, "publications", "Можно найти");
  await expect(page.getByText("Публикацией людей управляет владелец дерева.")).toBeVisible();
  await expect(page.locator(".publication-admin-list")).toHaveCount(0);
  await openAdminSection(page, "matches", "Связи деревьев");
  await expect(page.getByText("Связями с другими деревьями управляет владелец дерева.")).toBeVisible();

  await page.goto("/tree");
  await expect(page.getByTestId("rf__node-e2e-memorial-person")).toBeAttached();
  await expect(page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-privacy")).toHaveCount(0);
  expect(forbiddenCalls).toBe(0);
});

test("archive owner retains publication controls in a multi-archive account view", async ({ page }) => {
  await page.route((url) => url.pathname === "/api/family" && url.searchParams.get("projection") === "overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    return route.fulfill({ response, json: { ...data, local: false } });
  });
  await page.route((url) => url.pathname === "/api/account/archives", (route) =>
    route.fulfill({ json: { archives: [{ id: "owned-tree", title: "Моё дерево",
      role: "admin", approved: true, owned: true, current: true }] } }));

  await page.goto("/admin");
  await openAdminSection(page, "publications", "Можно найти");
  await expect(page.getByRole("searchbox", { name: "Найти человека" })).toBeVisible();
  await page.goto("/tree");
  await expect(page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-privacy")).toBeVisible();
});

test("local archive never probes account ownership while the overview is loading", async ({ page }) => {
  let directoryCalls = 0;
  await page.route((url) => url.pathname === "/api/account/archives", (route) => {
    directoryCalls += 1;
    return route.fulfill({ status: 401, json: { error: "Аккаунт не найден" } });
  });
  await page.goto("/tree");
  await expect(page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-privacy")).toBeVisible();
  expect(directoryCalls).toBe(0);
});
