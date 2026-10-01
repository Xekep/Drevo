import { expect, test } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";

test("archive admin proposes a match using only two published cards", async ({ page }) => {
  const own = { archiveId: "tree-a", id: "person-a", name: "Иван Петров", birthYear: "1900" };
  const target = { archiveId: "tree-b", id: "person-b", name: "Иван Петров", birthYear: "1901" };
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
    const showIgnored = new URL(route.request().url()).searchParams.get("ignored") === "1";
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
    expect(body.sourcePersonId).toBe("person-a");
    expect(body.targetPersonId).toBe("person-b");
    ignored = body.ignored;
    return route.fulfill({ json: { ignored } });
  });
  await page.route("**/api/discovery/matches", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({
        sourcePersonId: "person-a", targetArchiveId: "tree-b", targetPersonId: "person-b",
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
      return route.fulfill({ json: { shared: false } });
    }
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
});
