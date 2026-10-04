import { expect, test } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";

test("a selected tree card opens matching with its exact published source", async ({ page }) => {
  const own = { archiveId: "tree-a", id: "e2e-memorial-person", name: "Иван Петров" };
  const target = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  let posted = false;
  await page.route("**/a/tree-a/api/**", (route) => route.continue({
    url: route.request().url().replace("/a/tree-a/api/", "/api/"),
  }));
  await page.route("**/api/account/archives", (route) => route.fulfill({ json: { archives: [
    { id: "tree-a", title: "Моё дерево", role: "admin", approved: true, owned: true, current: true },
  ] } }));
  await page.route("**/api/discovery/matches/own-people?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    // The source is deliberately absent from the ordinary first search page.
    return route.fulfill({ json: { archiveId: "tree-a",
      people: params.get("personId") === own.id ? [own] : [] } });
  });
  await page.route("**/api/discovery/matches/candidates?**", (route) => {
    expect(new URL(route.request().url()).searchParams.get("sourcePersonId")).toBe(own.id);
    return route.fulfill({ json: { candidates: [{ ...target, reasons: ["Совпадают имена"], conflicts: [] }],
      nextCursor: null } });
  });
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toMatchObject({
        sourcePersonId: own.id, targetArchiveId: target.archiveId, targetPersonId: target.id,
      });
      posted = true;
      return route.fulfill({ json: { match: { status: "pending" } } });
    }
    return route.fulfill({ json: { archiveId: "tree-a", matches: [], nextCursor: null } });
  });
  await page.goto("/a/tree-a/tree");
  await page.getByTestId("rf__node-e2e-memorial-person").click();
  const handoff = page.getByRole("link", { name: "Найти совпадения в других деревьях" });
  await expect(handoff).toHaveAttribute("href", "/a/tree-a/manage/matches/from/e2e-memorial-person");
  await handoff.click();
  await expect(page).toHaveURL(/\/a\/tree-a\/manage\/matches\/from\/e2e-memorial-person$/);
  await expect(page.getByRole("heading", { name: "Карточка из вашего дерева" })).toBeVisible();
  await page.getByRole("button", { name: /Иван Петров.*Совпадают имена/ }).click();
  await expect(page.getByRole("heading", { name: "Проверьте обе карточки" })).toBeVisible();
  await page.getByRole("button", { name: "Предложить сопоставление" }).click();
  await expect(page.getByText("Запрос отправлен. Другая сторона должна подтвердить сопоставление.")).toBeVisible();
  expect(posted).toBe(true);
});

test("an unpublished source can be published before matching", async ({ page }) => {
  const own = { archiveId: "tree-a", id: "e2e-memorial-person", name: "Иван Тестов" };
  let published = false;
  await page.route("**/a/tree-a/api/**", (route) => route.continue({
    url: route.request().url().replace("/a/tree-a/api/", "/api/"),
  }));
  await page.route("**/api/discovery/matches/own-people?**", (route) => {
    const exact = new URL(route.request().url()).searchParams.has("personId");
    return route.fulfill(exact && !published
      ? { status: 404, json: { error: "Карточка не опубликована" } }
      : { json: { archiveId: "tree-a", people: exact ? [own] : [] } });
  });
  await page.route("**/api/discovery/matches/candidates?**", (route) =>
    route.fulfill({ json: { candidates: [], nextCursor: null } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", matches: [], nextCursor: null } }));
  await page.route("**/api/admin/published-people/e2e-memorial-person", (route) => {
    if (route.request().method() === "PUT") published = true;
    return route.fulfill({ json: { archiveId: "tree-a", published, publishable: true,
      fields: { birthSurname: false, birthYear: false, deathYear: false,
        birthPlace: false, deathPlace: false }, person: { name: "Иван Тестов" } } });
  });
  await page.goto("/a/tree-a/manage/matches/from/e2e-memorial-person");
  await expect(page.getByRole("heading", { name: "Карточка из вашего дерева" })).toHaveCount(0);
  await page.getByRole("button", { name: "Открыть публикацию карточки" }).click();
  await page.getByRole("button", { name: "Опубликовать в поиске" }).click();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Карточка из вашего дерева" })).toBeVisible();
  await expect(page.getByText("Иван Тестов").first()).toBeVisible();
});

test("a non-owner does not get the cross-tree handoff on a tree card", async ({ page }) => {
  await page.route("**/a/tree-a/api/**", (route) => route.continue({
    url: route.request().url().replace("/a/tree-a/api/", "/api/"),
  }));
  await page.route((url) => url.pathname === "/a/tree-a/api/family" &&
    url.searchParams.get("projection") === "overview", async (route) => {
    const response = await route.fetch({ url: route.request().url().replace("/a/tree-a/api/", "/api/") });
    const data = await response.json();
    return route.fulfill({ response, json: { ...data, local: false } });
  });
  await page.route("**/api/account/archives", (route) => route.fulfill({ json: { archives: [
    { id: "tree-a", title: "Чужое дерево", role: "admin", approved: true, owned: false, current: true },
  ] } }));
  await page.goto("/a/tree-a/tree");
  await page.getByTestId("rf__node-e2e-memorial-person").click();
  await expect(page.getByRole("link", { name: "Найти совпадения в других деревьях" })).toHaveCount(0);
});

test("a published-card link preselects its exact target for an owning archive", async ({ page }) => {
  const own = { archiveId: "tree-a", id: "person-a", name: "Иван Петров", birthYear: "1900" };
  const target = { archiveId: "tree-b", id: "person-b", name: "Иван Петров", birthYear: "1901" };
  let posted = false;
  // The SQLite browser fixture has one archive. Reuse it for a scoped route while
  // supplying the PostgreSQL-only discovery responses explicitly below.
  await page.route("**/a/tree-a/api/**", (route) => route.continue({
    url: route.request().url().replace("/a/tree-a/api/", "/api/"),
  }));
  await page.route("**/api/discovery/people/tree-b/person-b", (route) =>
    route.fulfill({ json: { person: target, linkedCards: [] } }));
  await page.route("**/api/account/archives", (route) => route.fulfill({ json: { archives: [
    { id: "tree-a", title: "Моё дерево", role: "admin", approved: true, owned: true, current: true },
    { id: "tree-b", title: "Дерево адресата", role: "admin", approved: true, owned: false, current: false },
    { id: "tree-c", title: "Чужое дерево", role: "admin", approved: true, owned: false, current: false },
  ] } }));
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [own] } }));
  await page.route("**/api/discovery/matches/candidates?**", (route) =>
    route.fulfill({ json: { candidates: [], nextCursor: null } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toMatchObject({
        sourcePersonId: own.id, targetArchiveId: target.archiveId, targetPersonId: target.id,
      });
      posted = true;
      return route.fulfill({ json: { match: { status: "pending" } } });
    }
    return route.fulfill({ json: { archiveId: "tree-a", matches: [], nextCursor: null } });
  });
  await page.goto("/discover/person/tree-b/person-b");
  const handoff = page.getByRole("link", { name: "Открыть сопоставление в дереве «Моё дерево»" });
  await expect(handoff).toHaveAttribute("href", "/a/tree-a/manage/matches/target/tree-b/person-b");
  await expect(page.getByRole("link", { name: /Дерево адресата|Чужое дерево/ })).toHaveCount(0);
  await handoff.click();
  await expect(page).toHaveURL(/\/a\/tree-a\/manage\/matches\/target\/tree-b\/person-b$/);
  await expect(page.getByRole("heading", { name: "Карточка из ссылки" })).toBeVisible();
  await page.getByRole("button", { name: /Иван Петров.*1900/ }).click();
  await expect(page.getByRole("heading", { name: "Проверьте обе карточки" })).toBeVisible();
  await page.getByRole("button", { name: "Предложить сопоставление" }).click();
  await expect(page.getByText("Запрос отправлен. Другая сторона должна подтвердить сопоставление.")).toBeVisible();
  expect(posted).toBe(true);
});

test("archive admin proposes a match using only two published cards", async ({ page }) => {
  const own = { archiveId: "tree-a", id: "family:человек.1", name: "Иван Петров", birthYear: "1900" };
  const target = { archiveId: "tree-b", id: "ветка:person.2", name: "Иван Петров", birthYear: "1901" };
  let requested = false;
  let ignored = false;
  let archiveIgnored = false;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [own] } }));
  await page.route("**/api/discovery/people?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("excludeArchiveId")).toBe("tree-a");
    return route.fulfill({ json: params.get("cursor") === "page2"
      ? { results: [{ archiveId: "tree-c", id: "person-c", name: "Иван Сидоров" }], nextCursor: null }
      : { results: [target], nextCursor: "page2" } });
  });
  await page.route("**/api/discovery/matches/candidates?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("sourcePersonId")).toBe(own.id);
    const showIgnored = params.get("ignored") === "1";
    return route.fulfill({ json: { candidates: !archiveIgnored && showIgnored === ignored ? [{ ...target,
      reasons: ["Совпадают имя и фамилия", "Год рождения близок (±2 года)"], conflicts: [],
    }] : [], truncated: false } });
  });
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: archiveIgnored ? [{ archiveId: "tree-b",
      exampleName: "Иван Петров" }] : [], nextPage: null } }));
  await page.route("**/api/discovery/matches/ignored-archives", (route) => {
    const body = route.request().postDataJSON();
    expect(body.targetArchiveId).toBe("tree-b");
    archiveIgnored = body.ignored;
    return route.fulfill({ json: { ignored: archiveIgnored } });
  });
  await page.route("**/api/discovery/matches/ignored", (route) => {
    const body = route.request().postDataJSON();
    expect(body.sourcePersonId).toBe(own.id);
    expect(body.targetPersonId).toBe(target.id);
    ignored = body.ignored;
    return route.fulfill({ json: { ignored } });
  });
  await page.route("**/api/discovery/matches", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({
        sourcePersonId: own.id, targetArchiveId: "tree-b", targetPersonId: target.id,
        reason: "Совпадает место рождения",
      });
      requested = true;
      return route.fulfill({ json: { match: { id: "match-1", status: "pending",
        reason: "Совпадает место рождения" } } });
    }
    return route.fulfill({ json: { archiveId: "tree-a", matches: requested ? [{
      id: "match-1", status: "pending", initiatedByArchiveId: "tree-a",
      requestedAt: "2026-09-30T00:00:00Z", left: own, right: target,
      reason: "Совпадает место рождения",
    }] : [], nextCursor: null } });
  });
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByRole("searchbox", { name: "Человек из этого дерева" }).fill("Иван");
  await page.getByRole("button", { name: /Иван Петров.*1900/ }).click();
  await expect(page.getByText(/Год рождения близок/)).toBeVisible();
  await page.getByRole("button", { name: "Не тот" }).click();
  await page.getByRole("button", { name: "Скрытые" }).click();
  await page.getByRole("button", { name: "Вернуть", exact: true }).click();
  await page.getByRole("button", { name: "К предложениям" }).click();
  await expect(page.getByText(/Год рождения близок/)).toBeVisible();
  await page.getByRole("button", { name: "Скрыть дерево" }).click();
  await expect(page.getByText("Пока совпадений нет. Можно найти карточку вручную.")).toBeVisible();
  await page.getByText("Скрытые деревья", { exact: false }).click();
  await expect(page.getByText("Дерево с карточкой «Иван Петров»")).toBeVisible();
  await page.getByRole("button", { name: "Вернуть дерево" }).click();
  await expect(page.getByText(/Год рождения близок/)).toBeVisible();
  await page.getByRole("searchbox", { name: "Карточка из другого дерева" }).fill("Иван");
  await page.getByRole("button", { name: "Показать ещё" }).click();
  await expect(page.locator(".match-options").last()).toContainText("Иван Сидоров");
  await page.locator(".match-options").last().getByRole("button", { name: /Иван Петров.*1901/ }).click();
  await expect(page.getByRole("heading", { name: "Проверьте обе карточки" })).toBeVisible();
  await page.getByRole("textbox", { name: /Почему это один человек/ }).fill("Совпадает место рождения");
  await page.getByRole("button", { name: "Предложить сопоставление" }).click();
  await expect(page.getByText("Ожидает подтверждения")).toBeVisible();
  await expect(page.getByText("Основание: Совпадает место рождения")).toBeVisible();
  await expect(page.getByRole("button", { name: "Подтвердить", exact: true })).toHaveCount(0);
});

test("a stale candidate page clears earlier suggestions and can be retried", async ({ page }) => {
  const own = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  let stale = false;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [own] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", matches: [], nextCursor: null } }));
  await page.route("**/api/discovery/matches/candidates?**", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor) {
      stale = true;
      return route.fulfill({ status: 409, json: { error: "Опубликованные карточки изменились" } });
    }
    return route.fulfill({ json: { candidates: [{ archiveId: "tree-b",
      id: stale ? "fresh" : "old", name: stale ? "Новая карточка" : "Старая карточка",
      reasons: ["Совпадает имя"], conflicts: [] }], nextCursor: stale ? null : "page2" } });
  });
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByRole("searchbox", { name: "Человек из этого дерева" }).fill("Иван");
  await page.getByRole("button", { name: /Иван Петров/ }).click();
  await expect(page.locator(".match-suggestion-list")).toContainText("Старая карточка");
  await page.locator(".match-suggestions").getByRole("button", { name: "Показать ещё похожих" }).click();
  await expect(page.locator(".match-suggestion-list")).not.toContainText("Старая карточка");
  await expect(page.getByRole("button", { name: "Обновить подсказки" })).toBeVisible();
  await page.getByRole("button", { name: "Обновить подсказки" }).click();
  await expect(page.locator(".match-suggestion-list")).toContainText("Новая карточка");
});

test("a changed published card requires a fresh review before acceptance", async ({ page }) => {
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  const decisionNote = "Сверены опубликованные сведения";
  let stale = true;
  let linked = false;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-b", people: [right] } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-b", nextCursor: null, matches: [{ id: "match-1", left, right,
      initiatedByArchiveId: "tree-a", status: linked ? "linked" : "pending",
      ...(linked ? { decisionNote } : {}),
      reviewToken: stale ? "old-token" : "new-token", changedSinceRequest: !stale,
      requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.route("**/api/discovery/matches/match-1", (route) => {
    const body = route.request().postDataJSON();
    expect(body.decision).toBe("accept");
    expect(body.note).toBe(decisionNote);
    if (stale) {
      expect(body.reviewToken).toBe("old-token");
      stale = false;
      return route.fulfill({ status: 409, json: { error: "Карточки изменились. Проверьте сведения ещё раз перед подтверждением" } });
    }
    expect(body.reviewToken).toBe("new-token");
    linked = true;
    return route.fulfill({ json: { match: { status: "linked" } } });
  });
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByText("Добавить пояснение").click();
  await page.getByRole("textbox", { name: /Пояснение к решению/ }).fill(decisionNote);
  await expect(page.getByText(/Его увидят владельцы обоих деревьев/)).toBeVisible();
  await page.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page.getByRole("alert")).toContainText("Проверьте сведения ещё раз");
  await expect(page.getByText("Опубликованные сведения изменились после запроса. Сверьте обе карточки перед решением.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Подтвердить" })).toHaveAttribute("data-review-token", "new-token");
  await page.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page.getByText("Сопоставлено")).toBeVisible();
  await expect(page.getByText(`Пояснение решения: ${decisionNote}`)).toBeVisible();
});

test("a linked pair shows the confirmation history and a field-only change notice", async ({ page }) => {
  const left = { archiveId: "tree-a", id: "person-a", name: "Исправленное имя" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Имя второй карточки" };
  let published = true;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-b", people: [right] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-b", nextCursor: null, matches: [
      { id: "match-1", left: published ? left : { archiveId: "tree-a", id: "person-a" },
        right, initiatedByArchiveId: "tree-a", status: published ? "linked" : "revoked",
        requestedAt: "2026-09-30T00:00:00Z",
        ...(published ? { confirmationHistoryAvailable: true, changedSinceConfirmation: true,
          changedFieldsSinceConfirmation: [{ side: "left", field: "name" }],
          confirmation: { confirmedAt: "2026-09-30T12:00:00Z", requestedBy: "owner-a",
            confirmedBy: "owner-b", leftPublicationVersion: "v1",
            rightPublicationVersion: "v1", left: { name: "Прежнее имя" },
            right: { name: "Имя второй карточки" } } } : {}),
      },
      { id: "match-legacy", left, right, initiatedByArchiveId: "tree-a", status: "linked",
        requestedAt: "2026-09-29T00:00:00Z", confirmationHistoryAvailable: false },
    ],
  } }));
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  const confirmed = page.locator(".match-request").first();
  await expect(confirmed.getByText(/Опубликованные сведения изменились после подтверждения связи/))
    .toContainText("первая карточка — Имя");
  await confirmed.getByText("Сведения на момент подтверждения").click();
  await expect(confirmed).toContainText("Прежнее имя");
  await expect(confirmed).not.toContainText("owner-a");
  await expect(confirmed).not.toContainText("owner-b");
  await expect(page.locator(".match-request").nth(1)).toContainText(
    "История сведений на момент подтверждения для этой связи недоступна.");
  published = false;
  await page.reload();
  await openAdminSection(page, "matches", "Связи деревьев");
  await expect(page.locator(".match-request").first()).not.toContainText("Прежнее имя");
  await expect(page.locator(".match-request").first()).not.toContainText(
    "Опубликованные сведения изменились после подтверждения связи");
});

test("an incoming owner compares only currently published fields before confirmation", async ({ page }) => {
  const own = { archiveId: "tree-b", id: "person-b", name: "Иван Петров",
    birthYear: "1902", birthPlace: "Тула" };
  const other = { archiveId: "tree-a", id: "person-a", name: "Иван Петров",
    birthYear: "1900" };
  let published = true;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-b", people: [own] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-b", nextCursor: null, matches: [{ id: "match-1", left: published ? other :
      { archiveId: "tree-a", id: "person-a" }, right: own,
      initiatedByArchiveId: "tree-a", status: "pending", reviewToken: published ? "review" : undefined,
      requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  const request = page.locator(".match-request");
  const comparison = request.getByRole("region", { name: "Сравнение опубликованных полей" });
  await expect(comparison).toBeVisible();
  await expect(comparison.locator("dl > div").filter({ hasText: "Имя" }))
    .toContainText("Текст совпадает");
  await expect(comparison.locator("dl > div").filter({ hasText: "Год рождения" }))
    .toContainText("Текст различается");
  await expect(comparison).toContainText("Ваше дерево: 1902");
  await expect(comparison).toContainText("Другое дерево: 1900");
  await expect(comparison.locator("dl > div").filter({ hasText: "Место рождения" }))
    .toContainText("Недостаточно опубликованных сведений");
  await expect(comparison).toContainText("Другое дерево: Нет в публикации");
  await expect(comparison).not.toContainText("дата рождения");
  published = false;
  await page.reload();
  await openAdminSection(page, "matches", "Связи деревьев");
  await expect(page.locator(".match-request").getByRole("region",
    { name: "Сравнение опубликованных полей" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Подтвердить" })).toBeDisabled();
});

test("rejecting a manual match hides only the recipient's candidate until restored", async ({ page }) => {
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  let rejected = false;
  let restored = false;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-b", people: [right] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches/candidates?**", (route) => {
    const hidden = new URL(route.request().url()).searchParams.get("ignored") === "1";
    const visible = rejected && !restored ? hidden : !hidden;
    return route.fulfill({ json: { candidates: visible ? [{ ...left,
      reasons: ["Совпадают имена"], conflicts: [] }] : [], nextCursor: null } });
  });
  await page.route("**/api/discovery/matches/ignored", (route) => {
    expect(route.request().postDataJSON()).toEqual({ sourcePersonId: "person-b",
      targetArchiveId: "tree-a", targetPersonId: "person-a", ignored: false });
    restored = true;
    return route.fulfill({ json: { ignored: false } });
  });
  await page.route("**/api/discovery/matches/match-1", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      decision: "reject", note: "Имена относятся к разным людям",
    });
    rejected = true;
    return route.fulfill({ json: { match: { status: "rejected" } } });
  });
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-b", nextCursor: null, matches: [{ id: "match-1", left, right,
      initiatedByArchiveId: "tree-a", status: rejected ? "rejected" : "pending",
      ...(rejected ? { decisionNote: "Имена относятся к разным людям" } : {}),
      requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByRole("button", { name: "Иван Петров", exact: false }).first().click();
  await expect(page.locator(".match-suggestion")).toHaveCount(1);
  await page.getByText("Добавить пояснение").click();
  await page.getByRole("textbox", { name: /Пояснение к решению/ })
    .fill("Имена относятся к разным людям");
  await page.getByRole("button", { name: "Не тот человек" }).click();
  await expect(page.getByText("Эта подсказка скрыта для вашего дерева", { exact: false })).toBeVisible();
  await expect(page.getByText("Пояснение решения: Имена относятся к разным людям"))
    .toBeVisible();
  await expect(page.locator(".match-suggestion")).toHaveCount(0);
  await page.getByRole("button", { name: "Скрытые" }).click();
  await expect(page.locator(".match-suggestion")).toHaveCount(1);
  await page.getByRole("button", { name: "Вернуть", exact: true }).click();
  await page.getByRole("button", { name: "К предложениям" }).click();
  await expect(page.locator(".match-suggestion")).toHaveCount(1);
  await expect(page.getByText("Отклонено")).toBeVisible();
});

test("later defers only an incoming request for this visit without answering", async ({ page }) => {
  const own = { archiveId: "tree-b", id: "person-b", name: "Иван Белов" };
  const other = { archiveId: "tree-a", id: "person-a", name: "Иван Алексеев" };
  const third = { archiveId: "tree-c", id: "person-c", name: "Иван Сидоров" };
  const matches = [
    { id: "incoming", status: "pending", initiatedByArchiveId: "tree-a",
      requestedAt: "2026-09-30T00:00:00Z", left: other, right: own, reason: "Входящий запрос" },
    { id: "outgoing", status: "pending", initiatedByArchiveId: "tree-b",
      requestedAt: "2026-09-30T00:00:00Z", left: own, right: third, reason: "Исходящий запрос" },
  ];
  let decisions = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/api/discovery/matches/")) decisions++;
  });
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-b", people: [own] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) =>
    route.fulfill({ json: { archiveId: "tree-b", matches, nextCursor: null } }));

  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  const incoming = page.locator(".match-request").filter({ hasText: "Входящий запрос" });
  const outgoing = page.locator(".match-request").filter({ hasText: "Исходящий запрос" });
  await expect(incoming.getByRole("button", { name: "Позже" })).toBeVisible();
  await expect(outgoing.getByRole("button", { name: "Позже" })).toHaveCount(0);
  await incoming.getByText("Добавить пояснение").click();
  await incoming.getByRole("textbox", { name: /Пояснение к решению/ })
    .fill("Черновик, который не отправляется");
  await incoming.getByRole("button", { name: "Позже" }).click();
  await expect(incoming).toHaveCount(0);
  await expect(outgoing).toBeVisible();
  await expect(page.getByText("Ответ другой стороне не отправлен.", { exact: false })).toBeVisible();
  expect(decisions).toBe(0);

  await page.getByRole("button", { name: "Показать сейчас" }).click();
  await expect(incoming).toBeVisible();
  await expect(page.getByText("Отложенные запросы снова показаны.")).toBeVisible();
  await incoming.getByRole("button", { name: "Позже" }).click();
  await page.reload();
  await openAdminSection(page, "matches", "Связи деревьев");
  await expect(incoming).toBeVisible();
  expect(decisions).toBe(0);
});

test("linked cards keep their archive of origin visible with identical names", async ({ page }, testInfo) => {
  const otherArchiveId = "another-archive-with-a-long-identifier-0123456789-abcdef-uvwxyz";
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: otherArchiveId, id: "person-b", name: "Иван Петров" };
  let currentArchiveId = "tree-a";
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: currentArchiveId, people: [] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: currentArchiveId, nextCursor: null, matches: [{
      id: "linked-1", left, right, initiatedByArchiveId: "tree-a", status: "linked",
      requestedAt: "2026-09-30T00:00:00Z",
    }],
  } }));

  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  const origins = page.locator(".match-request .match-candidate-origin");
  await expect(page.locator(".match-request .match-candidate-card a")).toHaveText(["Иван Петров", "Иван Петров"]);
  await expect(origins).toHaveText(["Ваш архив", `Исходный архив: ${otherArchiveId}`]);
  await expect(origins.nth(1)).toHaveAttribute("title", `Исходный архив: ${otherArchiveId}`);
  if (testInfo.project.name === "mobile") {
    expect(await origins.nth(1).evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }

  currentArchiveId = otherArchiveId;
  await page.reload();
  await openAdminSection(page, "matches", "Связи деревьев");
  await expect(origins).toHaveText(["Исходный архив: tree-a", "Ваш архив"]);
});

test("an open matches list drops a revoked link and an older in-flight response", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  let revoked = false;
  let reads = 0;
  let staleFinished = false;
  let finishRecheck = () => {};
  const delayedRecheck = new Promise<void>((resolve) => { finishRecheck = resolve; });
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [left] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", async (route) => {
    reads++;
    const wasRevoked = revoked;
    const body = { archiveId: "tree-a", nextCursor: null, matches: [{
      id, left, right, initiatedByArchiveId: "tree-a",
      status: wasRevoked ? "revoked" : "linked", requestedAt: "2026-09-30T00:00:00Z",
    }] };
    if (reads === 2) {
      await delayedRecheck;
      // The browser can cancel this request when the later visibility check starts.
      await route.fulfill({ json: body }).catch(() => {});
      staleFinished = true;
      return;
    }
    return route.fulfill({ json: body });
  });

  await page.goto("/manage/matches");
  await expect(page.getByText("Сопоставлено", { exact: true })).toBeVisible();
  await expect(page.getByText("Поделиться разрешённой веткой")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => reads).toBeGreaterThan(1);
  await expect(page.getByText("Проверяем доступность связей…")).toBeVisible();
  await expect(page.getByText("Поделиться разрешённой веткой")).toHaveCount(0);
  revoked = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => reads).toBeGreaterThan(2);
  finishRecheck();
  await expect.poll(() => staleFinished).toBe(true);
  await expect(page.getByText("Связь отозвана", { exact: true })).toBeVisible();
  await expect(page.getByText("Поделиться разрешённой веткой")).toHaveCount(0);
});

test("candidate suggestions can continue past the first indexed page", async ({ page }) => {
  const own = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const first = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  const later = { archiveId: "tree-c", id: "person-c", name: "Иван Петров" };
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [own] } }));
  await page.route("**/api/discovery/matches/candidates?**", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return route.fulfill({ json: cursor === "next-page"
      ? { candidates: [{ ...later, reasons: ["Совпадает имя и фамилия"], conflicts: [] }],
        nextCursor: null, approximate: true, partial: false }
      : { candidates: [{ ...first, reasons: ["Совпадает имя и фамилия"], conflicts: [] }],
        nextCursor: "next-page", approximate: true, partial: true } });
  });
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", matches: [], nextCursor: null } }));
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByRole("searchbox", { name: "Человек из этого дерева" }).fill("Иван");
  await page.getByRole("button", { name: /Иван Петров/ }).first().click();
  await expect(page.locator(".match-suggestion")).toHaveCount(1);
  await expect(page.getByText("Приближённые совпадения проверяются ограниченной порцией", { exact: false })).toBeVisible();
  await expect(page.getByText("Можно продолжить поиск на следующей странице.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Показать ещё похожих" }).click();
  await expect(page.locator(".match-suggestion")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Показать ещё похожих" })).toHaveCount(0);
  await expect(page.getByText("Можно продолжить поиск на следующей странице.", { exact: false })).toHaveCount(0);
});

test("a broad relative search asks for publication refinement and retries", async ({ page }) => {
  const own = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  let attempts = 0;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [own] } }));
  await page.route("**/api/discovery/matches/candidates?**", (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({ status: 422, json: { refineRequired: true,
        relativeConsentLimit: 32, relativeConsentRowLimit: 128 } })
      : route.fulfill({ json: { candidates: [], nextCursor: null,
        approximate: false, partial: false } });
  });
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", matches: [], nextCursor: null } }));
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByRole("searchbox", { name: "Человек из этого дерева" }).fill("Иван");
  await page.getByRole("button", { name: /Иван Петров/ }).first().click();
  await expect(page.getByText("Для поиска по родству оставьте не более 32 разных", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Открыть карточку" })).toBeVisible();
  await page.getByRole("button", { name: "Повторить поиск" }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByText("Для поиска по родству оставьте не более 32 разных", { exact: false })).toHaveCount(0);
});

test("an admin reviews and revokes an explicit linked-card snapshot", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  let shared = false;
  let linked = true;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [left] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-a", nextCursor: null, matches: [{ id, left, right,
      initiatedByArchiveId: "tree-a", status: "linked", requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.route(`**/api/discovery/matches/${id}/card-share`, (route) => {
    const method = route.request().method();
    if (method === "PUT") {
      expect(route.request().postDataJSON()).toEqual({
        fields: ["occupation"], previewToken: "a".repeat(64),
        recipientArchiveId: "tree-b", durationDays: 30,
      });
      shared = true;
      return route.fulfill({ json: { fields: { occupation: "Историк" } } });
    }
    if (method === "DELETE") {
      shared = false;
      linked = false; // The match is revoked concurrently before the UI refreshes.
      return route.fulfill({ json: { shared: false } });
    }
    if (!linked) return route.fulfill({ status: 404, json: { error: "Связь не найдена" } });
    return route.fulfill({ json: {
      available: { occupation: "Историк" }, previewToken: "a".repeat(64),
      recipientArchiveId: "tree-b", recipientPersonName: "Иван Петров",
      outgoing: shared ? { fields: { occupation: "Историк" },
        grantedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-30T00:00:00Z" } : null,
      incoming: null,
    } });
  });
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByText("Дополнительные сведения связанной карточки").click();
  const panel = page.locator(".match-card-share").filter({ hasText: "Дополнительные сведения связанной карточки" });
  await expect(panel).toContainText("Адресат: опубликованная карточка «Иван Петров», архив tree-b");
  await expect(page.getByRole("checkbox", { name: /Род занятий: Историк/ })).toBeVisible();
  await page.getByRole("checkbox", { name: /Род занятий: Историк/ }).check();
  await page.getByLabel("Срок нового разрешения").selectOption("30");
  await page.getByRole("button", { name: "Поделиться выбранным" }).click();
  await expect(panel).toContainText("Ваше разрешение действует до");
  await expect(page.getByText("Сейчас открыто другой стороне")).toBeVisible();
  await page.getByRole("button", { name: "Отозвать доступ" }).click();
  await expect(page.getByText("Сейчас открыто другой стороне")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /Род занятий: Историк/ })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Связь не найдена");
});

test("reopening a linked-card panel discards revoked and in-flight snapshots", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  let reads = 0;
  let releaseSecond!: () => void;
  const secondRead = new Promise<void>((resolve) => { releaseSecond = resolve; });
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [left] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-a", nextCursor: null, matches: [{ id, left, right,
      initiatedByArchiveId: "tree-a", status: "linked", requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.route(`**/api/discovery/matches/${id}/card-share`, async (route) => {
    const read = ++reads;
    if (read === 2) await secondRead;
    await route.fulfill({ json: { available: {}, previewToken: "a".repeat(64), outgoing: null,
      recipientArchiveId: "tree-b", recipientPersonName: "Иван Петров",
      incoming: read < 3 ? { fields: { occupation: "Уже отозванные сведения" },
        grantedAt: "2026-10-01T00:00:00Z", expiresAt: null } : null } }).catch(() => {});
  });
  try {
    await page.goto("/manage");
    await openAdminSection(page, "matches", "Связи деревьев");
    const panel = page.locator(".match-card-share").filter({ hasText: "Дополнительные сведения связанной карточки" });
    await panel.locator("summary").click();
    await expect(panel).toContainText("Уже отозванные сведения");
    await panel.locator("summary").click();
    await panel.locator("summary").click();
    await expect.poll(() => reads).toBe(2);
    await expect(panel).not.toContainText("Уже отозванные сведения");
    await panel.locator("summary").click();
    releaseSecond();
    await panel.locator("summary").click();
    await expect.poll(() => reads).toBe(3);
    await expect(panel).toContainText("Дополнительные сведения пока не открыты.");
    await expect(panel).not.toContainText("Уже отозванные сведения");
  } finally { releaseSecond(); }
});

test("an owner previews only granted fields and loses the copy comparison after revoke", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  let permitted = true;
  let hasFields = true;
  let reads = 0;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [left] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-a", nextCursor: null, matches: [{ id, left, right,
      initiatedByArchiveId: "tree-a", status: "linked", requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.route(`**/api/discovery/matches/${id}/card-share`, (route) =>
    route.fulfill({ json: { available: {}, previewToken: "a".repeat(64), outgoing: null,
      recipientArchiveId: "tree-b", recipientPersonName: "Иван Петров",
      incoming: { fields: { occupation: "Архивный исследователь" },
        grantedAt: "2026-10-01T00:00:00Z", expiresAt: null },
    } }));
  await page.route(`**/api/discovery/matches/${id}/card-share/copy-preview`, (route) => {
    reads++;
    return permitted ? route.fulfill({ json: {
      source: { archiveId: "tree-b", personId: "person-b" },
      target: { archiveId: "tree-a", personId: "person-a" },
      fields: hasFields ? [{ field: "occupation", sourceValue: "Архивный исследователь",
        targetValue: "Местный исследователь", status: "conflict", copyable: false }] : [],
      quotaImpact: { additionalPeople: 0, additionalMediaBytes: 0 },
    } }) : route.fulfill({ status: 404, json: { error: "Связь не найдена" } });
  });
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  const panel = page.locator(".match-card-share").filter({ hasText: "Дополнительные сведения связанной карточки" });
  await panel.locator("summary").click();
  await panel.getByRole("button", { name: "Сравнить с моей карточкой" }).click();
  await expect(panel).toContainText("Предпросмотр копирования");
  await expect(panel).toContainText("Конфликт");
  await expect(panel).toContainText("Архивный исследователь");
  await expect(panel).toContainText("Местный исследователь");
  await expect(panel).toContainText("Источник: разрешённая связанная карточка другого архива");
  await expect(panel.locator(".match-copy-preview")).not.toContainText("tree-b");
  await expect(panel.getByRole("button", { name: "Скопировать выбранные поля" })).toBeDisabled();
  await expect(panel).toContainText("Пока доступно только сравнение");
  hasFields = false;
  await panel.getByRole("button", { name: "Сравнить с моей карточкой" }).click();
  await expect(panel).toContainText("Нет разрешённых текстовых полей для сравнения.");
  await expect(panel).not.toContainText("Местный исследователь");
  permitted = false;
  await panel.getByRole("button", { name: "Сравнить с моей карточкой" }).click();
  await expect.poll(() => reads).toBe(3);
  await expect(panel).toContainText("Связь не найдена");
  await expect(panel).not.toContainText("Местный исследователь");
});

test("copying a linked place requires field choice and separate conflict confirmation", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  let copied = false;
  let writes = 0;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [left] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-a", nextCursor: null, matches: [{ id, left, right,
      initiatedByArchiveId: "tree-a", status: "linked", requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.route(`**/api/discovery/matches/${id}/card-share`, (route) =>
    route.fulfill({ json: { available: {}, previewToken: "a".repeat(64), outgoing: null,
      recipientArchiveId: "tree-b", recipientPersonName: "Иван Петров",
      incoming: { fields: { birthPlace: "Архивный город", occupation: "Историк" },
        grantedAt: "2026-10-01T00:00:00Z", expiresAt: null },
    } }));
  await page.route(`**/api/discovery/matches/${id}/card-share/copy-preview`, (route) => {
    if (route.request().method() === "POST") {
      writes++;
      expect(route.request().postDataJSON()).toEqual({ fields: ["birthPlace"],
        confirmConflicts: ["birthPlace"], revision: 7, reviewToken: "c".repeat(64) });
      copied = true;
      return route.fulfill({ json: { revision: 8, copied: ["birthPlace"] } });
    }
    return route.fulfill({ json: {
      source: { archiveId: "tree-b", personId: "person-b" },
      target: { archiveId: "tree-a", personId: "person-a" },
      revision: copied ? 8 : 7, reviewToken: "c".repeat(64),
      fields: [{ field: "birthPlace", sourceValue: "Архивный город",
        targetValue: copied ? "Архивный город" : "Местный город",
        status: copied ? "same" : "conflict", copyable: true,
        ...(copied ? { copiedFrom: { archiveId: "tree-b", personId: "person-b",
          revision: 8, copiedAt: "2026-10-01T00:00:00Z" } } : {}) },
      { field: "occupation", sourceValue: "Историк", targetValue: null,
        status: "empty", copyable: false }],
      quotaImpact: { additionalPeople: 0, additionalMediaBytes: 0 },
    } });
  });
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  const panel = page.locator(".match-card-share").filter({ hasText: "Дополнительные сведения связанной карточки" });
  await panel.locator("summary").click();
  await panel.getByRole("button", { name: "Сравнить с моей карточкой" }).click();
  const apply = panel.getByRole("button", { name: "Скопировать выбранные поля" });
  await expect(apply).toBeDisabled();
  await panel.getByRole("checkbox", { name: "Скопировать место рождения" }).check();
  await expect(apply).toBeDisabled();
  await panel.getByRole("checkbox", { name: "Подтверждаю замену моего значения" }).check();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect.poll(() => writes).toBe(1);
  await expect(panel).toContainText("Происхождение сохранено");
  await expect(panel).toContainText("Значение ранее скопировано из другого архива");
  await expect(apply).toBeDisabled();
  await expect(panel.getByRole("checkbox", { name: "Скопировать род занятий" })).toHaveCount(0);
});

test("a linked branch needs both grants and clears a revoked projection", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  const parent = { id: "parent-a", relation: "parent", name: "Анна Петрова" };
  const grandparent = { id: "grandparent-a", relation: "grandparent",
    name: "Елена Петрова", viaIds: ["parent-a"] };
  const incoming = { id: "parent-b", relation: "parent", name: "Мария Петрова" };
  let ownReady = false;
  let otherReady = false;
  let linked = true;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [left] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-a", nextCursor: null, matches: [{ id, left, right,
      initiatedByArchiveId: "tree-a", status: "linked", requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.route(`**/api/discovery/matches/${id}/branch-share`, (route) => {
    const method = route.request().method();
    if (method === "PUT") {
      expect(route.request().postDataJSON()).toEqual({
        personIds: ["parent-a", "grandparent-a"], previewToken: "b".repeat(64),
        recipientArchiveId: "tree-b", durationDays: 30,
      });
      ownReady = true;
      return route.fulfill({ json: { shared: true } });
    }
    if (method === "DELETE") {
      ownReady = false;
      return route.fulfill({ json: { shared: false } });
    }
    if (!linked) return route.fulfill({ status: 404, json: { error: "Связь не найдена" } });
    return route.fulfill({ json: { available: [parent, grandparent], truncated: false,
      previewToken: "b".repeat(64), ownReady, otherReady,
      recipientArchiveId: "tree-b", recipientPersonName: "Иван Петров",
      ownExpiresAt: ownReady ? "2026-10-30T00:00:00Z" : null,
      outgoingIds: ownReady ? ["parent-a", "grandparent-a"] : [],
      incoming: ownReady && otherReady ? [incoming] : [],
    } });
  });
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByText("Поделиться разрешённой веткой").click();
  const panel = page.locator(".match-card-share").filter({ hasText: "Поделиться разрешённой веткой" });
  await expect(panel).toContainText("Адресат: опубликованная карточка «Иван Петров», архив tree-b");
  await expect(page.getByText("Анна Петрова")).toBeVisible();
  const ancestorOption = page.getByRole("checkbox", { name: /Предок.*Елена Петрова/ });
  await expect(ancestorOption).toBeDisabled();
  await expect(page.getByText("Мария Петрова")).toHaveCount(0);
  await page.getByRole("checkbox", { name: /Родитель: Анна Петрова/ }).check();
  await expect(ancestorOption).toBeEnabled();
  await ancestorOption.check();
  await page.getByRole("checkbox", { name: /Родитель: Анна Петрова/ }).uncheck();
  await expect(ancestorOption).not.toBeChecked();
  await page.getByRole("checkbox", { name: /Родитель: Анна Петрова/ }).check();
  await ancestorOption.check();
  await page.getByLabel("Срок нового разрешения").selectOption("30");
  await page.getByRole("button", { name: "Разрешить выбранное" }).click();
  await expect(panel).toContainText("Ваше разрешение действует до");
  await expect(page.getByText("Ожидаем разрешения второй стороны.")).toBeVisible();
  otherReady = true;
  await page.getByRole("button", { name: "Обновить просмотр" }).click();
  await expect(page.getByText("Мария Петрова")).toBeVisible();
  await page.getByRole("button", { name: "Отозвать доступ к ветке" }).click();
  await expect(page.getByText("Мария Петрова")).toHaveCount(0);
  ownReady = true; linked = false;
  await page.getByRole("button", { name: "Обновить просмотр" }).click();
  await expect(page.getByText("Анна Петрова")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Связь не найдена");
});

test("a linked owner explicitly extends one published step and discards an old options response", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  const parent = { id: "parent-a", relation: "parent", name: "Анна Петрова" };
  const next = { id: "next-a", relation: "relative", name: "Елена Петрова",
    viaIds: ["parent-a"], previewToken: "c".repeat(64) };
  let added = false;
  let reads = 0;
  let releaseOld!: () => void;
  const oldRead = new Promise<void>((resolve) => { releaseOld = resolve; });
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [left] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-a", nextCursor: null, matches: [{ id, left, right,
      initiatedByArchiveId: "tree-a", status: "linked", requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.route(`**/api/discovery/matches/${id}/branch-share`, (route) =>
    route.fulfill({ json: { available: added ? [parent,next] : [parent], truncated: false,
      previewToken: "b".repeat(64), ownReady: true, otherReady: true,
      recipientArchiveId: "tree-b", recipientPersonName: "Иван Петров",
      ownExpiresAt: null, outgoingIds: added ? ["parent-a","next-a"] : ["parent-a"],
      incoming: [],
    } }));
  await page.route(`**/api/discovery/matches/${id}/branch-share/options/parent-a`, async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ personId: "next-a",
        previewToken: "c".repeat(64) });
      added = true;
      return route.fulfill({ json: { shared: true } });
    }
    const read = ++reads;
    if (read === 1) await oldRead;
    return route.fulfill({ json: { viaId: "parent-a", options: [next], nextCursor: null } })
      .catch(() => {});
  });
  try {
    await page.goto("/manage");
    await openAdminSection(page, "matches", "Связи деревьев");
    const panel = page.locator("details.match-card-share")
      .filter({ hasText: "Поделиться разрешённой веткой" });
    await panel.locator(":scope > summary").click();
    await panel.getByRole("button", { name: "Дальше от «Анна Петрова»" }).click();
    await expect.poll(() => reads).toBe(1);
    await panel.locator(":scope > summary").click();
    await panel.locator(":scope > summary").click();
    releaseOld();
    await expect(panel.getByRole("button", { name: "Добавить эту карточку" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Дальше от «Анна Петрова»" }).click();
    await expect(panel.getByText("Елена Петрова")).toBeVisible();
    await panel.getByRole("button", { name: "Добавить эту карточку" }).click();
    await expect(panel).toContainText("Карточка добавлена в ваш явный выбор");
    await expect(panel).toContainText("Елена Петрова");
    expect(added).toBe(true);
  } finally { releaseOld(); }
});

test("reopening a linked-branch panel discards revoked and in-flight members", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  const incoming = { id: "parent-b", relation: "parent", name: "Уже отозванный родственник" };
  let reads = 0;
  let releaseSecond!: () => void;
  const secondRead = new Promise<void>((resolve) => { releaseSecond = resolve; });
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [left] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-a", nextCursor: null, matches: [{ id, left, right,
      initiatedByArchiveId: "tree-a", status: "linked", requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.route(`**/api/discovery/matches/${id}/branch-share`, async (route) => {
    const read = ++reads;
    if (read === 2) await secondRead;
    await route.fulfill({ json: { available: [], truncated: false, previewToken: "b".repeat(64),
      ownReady: true, otherReady: true, outgoingIds: [], incoming: read < 3 ? [incoming] : [],
      recipientArchiveId: "tree-b", recipientPersonName: "Иван Петров", ownExpiresAt: null,
    } }).catch(() => {});
  });
  try {
    await page.goto("/manage");
    await openAdminSection(page, "matches", "Связи деревьев");
    const panel = page.locator(".match-card-share").filter({ hasText: "Поделиться разрешённой веткой" });
    await panel.locator("summary").click();
    await expect(panel).toContainText("Уже отозванный родственник");
    await panel.locator("summary").click();
    await panel.locator("summary").click();
    await expect.poll(() => reads).toBe(2);
    await expect(panel).not.toContainText("Уже отозванный родственник");
    await panel.locator("summary").click();
    releaseSecond();
    await panel.locator("summary").click();
    await expect.poll(() => reads).toBe(3);
    await expect(panel).toContainText("Другая сторона не выбрала родственников.");
    await expect(panel).not.toContainText("Уже отозванный родственник");
  } finally { releaseSecond(); }
});

test("a selected linked member opens through its own permission-checked URL", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  const incoming = { id: "family:person.1", relation: "parent", name: "Мария Петрова",
    birthYear: "1900" };
  let permitted = true;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [left] } }));
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-a", nextCursor: null, matches: [{ id, left, right,
      initiatedByArchiveId: "tree-a", status: "linked", requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.route(`**/api/discovery/matches/${id}/branch-share`, (route) =>
    route.fulfill({ json: { available: [], truncated: false, previewToken: "b".repeat(64),
      ownReady: true, otherReady: true, outgoingIds: [], incoming: [incoming],
      recipientArchiveId: "tree-b", recipientPersonName: "Иван Петров", ownExpiresAt: null } }));
  await page.route(`**/api/discovery/matches/${id}/branch-share/people/*`, (route) => {
    expect(decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!))
      .toBe("family:person.1");
    return permitted ? route.fulfill({ json: { person: { ...incoming, archiveId: "tree-b" } } })
      : route.fulfill({ status: 404, json: { error: "Карточка недоступна" } });
  });
  await page.goto("/manage");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByText("Поделиться разрешённой веткой").click();
  await expect(page.getByText("Мария Петрова")).toBeVisible();
  await page.getByRole("link", { name: "Открыть разрешённую карточку" }).click();
  await expect(page).toHaveURL(new RegExp(`/discover/linked/tree-a/${id}/family%3Aperson\\.1$`, "i"));
  await expect(page.getByRole("heading", { name: "Мария Петрова" })).toBeVisible();
  await expect(page.getByText("Родитель · Архив: tree-b")).toBeVisible();
  await expect(page.getByRole("link", { name: /media|Редактировать|Скачать/ })).toHaveCount(0);
  permitted = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Карточка недоступна");
  await expect(page.getByRole("heading", { name: "Мария Петрова" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Карточка недоступна");
  await page.getByRole("link", { name: "К сопоставлениям" }).click();
  await expect(page).toHaveURL(/\/a\/tree-a\/manage\/matches$/);
  // This fixture has a local SQLite archive, so tree-a is a mocked remote archive.
  await page.goto("/manage/matches");
  await expect(page.getByRole("heading", { name: "Запросы между деревьями" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Разделы админки" })
    .getByRole("button", { name: "Связи деревьев", exact: true }))
    .toHaveAttribute("aria-current", "page");
});
