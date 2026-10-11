import { expect, test, type Page } from "@playwright/test";
import type { Family, Person } from "../../src/domain/types.ts";

const person = (id: string, parents: string[] = []): Person => ({
  id, name: id, surname: "Тестов", patronymic: "", sex: "m",
  birth: "1970", birthPlace: "", parents, spouses: [], sources: [],
  generation: parents.length ? 2 : 1, column: 0,
});
const family: Family = {
  title: "Выбранное древо", description: "", demo: false,
  people: [person("parent"), person("child", ["parent"]), person("outside")],
  photos: [], links: [], unions: [],
};
const prefix = "/a/shared-archive";
const token = "S".repeat(43);

async function mockArchive(page: Page, owner: boolean) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const user = {
    id: "viewer", name: "Участник", role: "relative", treeRole: "relative",
    archiveOwner: owner, globalRole: null, approved: true,
    createdAt: "2026-10-11", treeAccess: "all",
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === "POST" ? request.postDataJSON() : null;
    requests.push({ path: url.pathname, method: request.method(), body });
    if (url.pathname.endsWith("/api/family"))
      return route.fulfill({ json: {
        family, user, revision: 7, local: false, canEdit: true,
        readTree: true, readPhotos: true, treePreferences: {},
      } });
    if (url.pathname.endsWith("/api/session"))
      return route.fulfill({ json: { user, local: false, account: user } });
    if (url.pathname === `${prefix}/api/shares` && request.method() === "POST") {
      expect(request.headers()["if-match"]).toBe("7");
      return route.fulfill({ status: 201, json: {
        path: `${prefix}/s/${token}`,
        share: { expiresAt: new Date(Date.now() + 3600000).toISOString() },
      } });
    }
    if (url.pathname === `${prefix}/api/shared/${token}`)
      return route.fulfill({ json: {
        family: { ...family, people: family.people.filter((p) => p.id !== "outside") },
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        serverTime: new Date().toISOString(),
      } });
    return route.fulfill({ json: { items: [], comments: [], categories: [], unread: 0 } });
  });
  return requests;
}

test("owner shares a fixed branch of the selected archive and opens its scoped guest view", async ({ page, context, isMobile }) => {
  test.skip(isMobile);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const requests = await mockArchive(page, true);
  await page.goto(`${prefix}/tree`);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  await page.locator('.flow-person[data-person-id="child"] .flow-person-content').click();
  await page.getByRole("button", { name: "Близкие", exact: true }).click();
  await page.getByRole("button", { name: "Поделиться", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Поделиться семьёй" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Срок действия" }).selectOption("720");
  await dialog.getByRole("button", { name: "Создать и скопировать" }).click();
  await expect(dialog.getByRole("status")).toContainText("Ссылка скопирована");
  const creation = requests.find((r) => r.method === "POST" && r.path.endsWith("/api/shares"));
  expect(creation?.body).toMatchObject({ anchorId: "child", durationHours: 720 });
  expect((creation?.body as { personIds: string[] }).personIds.sort()).toEqual(["child", "parent"]);
  const address = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(address).pathname).toBe(`${prefix}/s/${token}`);
  await page.goto(address);
  await expect(page.locator('.flow-person[data-person-id="child"]')).toBeVisible();
  await expect(page.locator('.flow-person[data-person-id="outside"]')).toHaveCount(0);
  expect(requests.some((r) => r.path === `${prefix}/api/shared/${token}`)).toBe(true);
  expect(requests.filter((r) => r.path === "/api/shares" || r.path === `/api/shared/${token}`)).toEqual([]);
});

test("editing member cannot issue public branch links in another owner's archive", async ({ page, isMobile }) => {
  test.skip(isMobile);
  await mockArchive(page, false);
  await page.goto(`${prefix}/tree`);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  await page.locator('.flow-person[data-person-id="child"] .flow-person-content').click();
  await page.getByRole("button", { name: "Близкие", exact: true }).click();
  await expect(page.getByRole("button", { name: "Поделиться", exact: true })).toHaveCount(0);
});
