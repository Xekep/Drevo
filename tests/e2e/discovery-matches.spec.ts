import { expect, test } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";

test("archive admin proposes a match using only two published cards", async ({ page }) => {
  const own = { archiveId: "tree-a", id: "person-a", name: "Иван Петров", birthYear: "1900" };
  const target = { archiveId: "tree-b", id: "person-b", name: "Иван Петров", birthYear: "1901" };
  let requested = false;
  await page.route("**/api/discovery/matches/own-people?**", (route) =>
    route.fulfill({ json: { archiveId: "tree-a", people: [own] } }));
  await page.route("**/api/discovery/people?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("excludeArchiveId")).toBe("tree-a");
    return route.fulfill({ json: params.get("cursor") === "page2"
      ? { results: [{ archiveId: "tree-c", id: "person-c", name: "Иван Сидоров" }], nextCursor: null }
      : { results: [target], nextCursor: "page2" } });
  });
  await page.route("**/api/discovery/matches/candidates?**", (route) =>
    route.fulfill({ json: { candidates: [{ ...target, reasons: ["Совпадают имя и фамилия",
      "Год рождения близок (±2 года)"], conflicts: [] }], truncated: false } }));
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
