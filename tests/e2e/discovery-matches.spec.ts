import { expect, test } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";

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
  await page.goto("/admin");
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

test("a changed published card requires a fresh review before acceptance", async ({ page }) => {
  const left = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const right = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  let stale = true;
  let linked = false;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-b", people: [right] } }));
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-b", nextCursor: null, matches: [{ id: "match-1", left, right,
      initiatedByArchiveId: "tree-a", status: linked ? "linked" : "pending",
      reviewToken: stale ? "old-token" : "new-token", changedSinceRequest: !stale,
      requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.route("**/api/discovery/matches/match-1", (route) => {
    const body = route.request().postDataJSON();
    expect(body.decision).toBe("accept");
    if (stale) {
      expect(body.reviewToken).toBe("old-token");
      stale = false;
      return route.fulfill({ status: 409, json: { error: "Карточки изменились. Проверьте сведения ещё раз перед подтверждением" } });
    }
    expect(body.reviewToken).toBe("new-token");
    linked = true;
    return route.fulfill({ json: { match: { status: "linked" } } });
  });
  await page.goto("/admin");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page.getByRole("alert")).toContainText("Проверьте сведения ещё раз");
  await expect(page.getByText("Опубликованные сведения изменились после запроса. Сверьте обе карточки перед решением.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Подтвердить" })).toHaveAttribute("data-review-token", "new-token");
  await page.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page.getByText("Сопоставлено")).toBeVisible();
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
    expect(route.request().postDataJSON()).toEqual({ decision: "reject" });
    rejected = true;
    return route.fulfill({ json: { match: { status: "rejected" } } });
  });
  await page.route("**/api/discovery/matches", (route) => route.fulfill({ json: {
    archiveId: "tree-b", nextCursor: null, matches: [{ id: "match-1", left, right,
      initiatedByArchiveId: "tree-a", status: rejected ? "rejected" : "pending",
      requestedAt: "2026-09-30T00:00:00Z" }],
  } }));
  await page.goto("/admin");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByRole("button", { name: "Иван Петров", exact: false }).first().click();
  await expect(page.locator(".match-suggestion")).toHaveCount(1);
  await page.getByRole("button", { name: "Не тот человек" }).click();
  await expect(page.getByText("Эта подсказка скрыта для вашего дерева", { exact: false })).toBeVisible();
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

  await page.goto("/admin");
  await openAdminSection(page, "matches", "Связи деревьев");
  const incoming = page.locator(".match-request").filter({ hasText: "Входящий запрос" });
  const outgoing = page.locator(".match-request").filter({ hasText: "Исходящий запрос" });
  await expect(incoming.getByRole("button", { name: "Позже" })).toBeVisible();
  await expect(outgoing.getByRole("button", { name: "Позже" })).toHaveCount(0);
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

  await page.goto("/admin");
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

test("candidate suggestions can continue past the first indexed page", async ({ page }) => {
  const own = { archiveId: "tree-a", id: "person-a", name: "Иван Петров" };
  const first = { archiveId: "tree-b", id: "person-b", name: "Иван Петров" };
  const later = { archiveId: "tree-c", id: "person-c", name: "Иван Петров" };
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [own] } }));
  await page.route("**/api/discovery/matches/candidates?**", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return route.fulfill({ json: cursor === "next-page"
      ? { candidates: [{ ...later, reasons: ["Совпадает имя и фамилия"], conflicts: [] }], nextCursor: null }
      : { candidates: [{ ...first, reasons: ["Совпадает имя и фамилия"], conflicts: [] }], nextCursor: "next-page" } });
  });
  await page.route("**/api/discovery/matches/ignored-archives?**", (route) =>
    route.fulfill({ json: { archives: [], nextPage: null } }));
  await page.route("**/api/discovery/matches", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", matches: [], nextCursor: null } }));
  await page.goto("/admin");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByRole("searchbox", { name: "Человек из этого дерева" }).fill("Иван");
  await page.getByRole("button", { name: /Иван Петров/ }).first().click();
  await expect(page.locator(".match-suggestion")).toHaveCount(1);
  await page.getByRole("button", { name: "Показать ещё похожих" }).click();
  await expect(page.locator(".match-suggestion")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Показать ещё похожих" })).toHaveCount(0);
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
      outgoing: shared ? { fields: { occupation: "Историк" }, grantedAt: "2026-10-01T00:00:00Z" } : null,
      incoming: null,
    } });
  });
  await page.goto("/admin");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByText("Дополнительные сведения связанной карточки").click();
  await expect(page.getByRole("checkbox", { name: /Род занятий: Историк/ })).toBeVisible();
  await page.getByRole("checkbox", { name: /Род занятий: Историк/ }).check();
  await page.getByRole("button", { name: "Поделиться выбранным" }).click();
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
      incoming: read < 3 ? { fields: { occupation: "Уже отозванные сведения" },
        grantedAt: "2026-10-01T00:00:00Z" } : null } }).catch(() => {});
  });
  try {
    await page.goto("/admin");
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
      incoming: { fields: { occupation: "Архивный исследователь" }, grantedAt: "2026-10-01T00:00:00Z" },
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
  await page.goto("/admin");
  await openAdminSection(page, "matches", "Связи деревьев");
  const panel = page.locator(".match-card-share").filter({ hasText: "Дополнительные сведения связанной карточки" });
  await panel.locator("summary").click();
  await panel.getByRole("button", { name: "Сравнить с моей карточкой" }).click();
  await expect(panel).toContainText("Предпросмотр копирования");
  await expect(panel).toContainText("Конфликт");
  await expect(panel).toContainText("Архивный исследователь");
  await expect(panel).toContainText("Местный исследователь");
  await expect(panel).toContainText("Источник: разрешённая связанная карточка другого архива");
  await expect(panel).not.toContainText("tree-b");
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
      incoming: { fields: { birthPlace: "Архивный город", occupation: "Историк" },
        grantedAt: "2026-10-01T00:00:00Z" },
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
  await page.goto("/admin");
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
        personIds: ["parent-a"], previewToken: "b".repeat(64),
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
    return route.fulfill({ json: { available: [parent], truncated: false,
      previewToken: "b".repeat(64), ownReady, otherReady,
      recipientArchiveId: "tree-b", recipientPersonName: "Иван Петров",
      ownExpiresAt: ownReady ? "2026-10-30T00:00:00Z" : null,
      outgoingIds: ownReady ? ["parent-a"] : [],
      incoming: ownReady && otherReady ? [incoming] : [],
    } });
  });
  await page.goto("/admin");
  await openAdminSection(page, "matches", "Связи деревьев");
  await page.getByText("Поделиться разрешённой веткой").click();
  const panel = page.locator(".match-card-share").filter({ hasText: "Поделиться разрешённой веткой" });
  await expect(panel).toContainText("Адресат: опубликованная карточка «Иван Петров», архив tree-b");
  await expect(page.getByText("Анна Петрова")).toBeVisible();
  await expect(page.getByText("Мария Петрова")).toHaveCount(0);
  await page.getByRole("checkbox", { name: /Родитель: Анна Петрова/ }).check();
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
    await page.goto("/admin");
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
  await page.goto("/admin");
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
});
