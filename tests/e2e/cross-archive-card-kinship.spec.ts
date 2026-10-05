import { expect, test, type Page } from "@playwright/test";
import type { ArchiveUser, TreeRole } from "../../src/domain/access.ts";
import type { Family, Person } from "../../src/domain/types.ts";
import { archiveContextAt } from "../../src/domain/archive-context.ts";

const person = (id: string, name: string, parents: string[] = []): Person => ({
  id,
  name,
  surname: "Тестов",
  patronymic: "",
  sex: "m",
  birth: "1970",
  birthPlace: "",
  parents,
  spouses: [],
  sources: [],
  generation: parents.length ? 2 : 1,
  column: 0,
});
const family: Family = {
  title: "Чужое древо",
  description: "",
  demo: false,
  people: [person("parent", "Иван"), person("child", "Пётр", ["parent"])],
  photos: [],
  links: [],
  unions: [],
};

async function mockArchives(
  page: Page,
  foreignPersonId: string | undefined,
  role: TreeRole,
) {
  const reads: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    reads.push(url.pathname);
    const context = archiveContextAt(url.pathname);
    const user: ArchiveUser = {
      id: "viewer",
      name: "Участник",
      role,
      treeRole: role,
      globalRole: null,
      archiveOwner: context?.id === "own-archive",
      approved: true,
      createdAt: "2026-10-05",
      personId: context?.id === "own-archive" ? "parent" : foreignPersonId,
      treeAccess: "all",
    };
    if (url.pathname.endsWith("/api/family"))
      return route.fulfill({
        json: {
          family,
          user,
          revision: 1,
          local: false,
          canEdit: role === "relative",
          readTree: true,
          readPhotos: true,
          treePreferences: {},
        },
      });
    if (url.pathname.endsWith("/api/session"))
      return route.fulfill({
        json: {
          user,
          local: false,
          account: { id: user.id, name: user.name, createdAt: user.createdAt },
        },
      });
    return route.fulfill({ json: { items: [], comments: [], categories: [] } });
  });
  return reads;
}

const card = (page: Page, id: string) =>
  page.locator(`.flow-person[data-person-id="${id}"]`).first();

for (const role of ["reader", "relative"] as const) {
  test(`foreign archive uses its own account binding, independent of selection (${role})`, async ({
    page,
  }) => {
    const reads = await mockArchives(page, "child", role);
    // Identical card IDs in two archives must not reuse the owner's binding.
    await page.goto("/a/own-archive/tree");
    await expect(
      card(page, "parent").locator(".portrait-card-info small"),
    ).toHaveText("Это вы");
    await expect(
      card(page, "child").locator(".portrait-card-info small"),
    ).toHaveText("Сын");
    await page.goto("/a/foreign-archive/tree");
    await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
    await expect(
      card(page, "child").locator(".portrait-card-info small"),
    ).toHaveText("Это вы");
    await expect(
      card(page, "parent").locator(".portrait-card-info small"),
    ).toHaveText("Отец");
    await card(page, "parent").locator(".flow-person-content").click();
    await expect(card(page, "parent")).toHaveClass(/is-selected/);
    await expect(
      card(page, "parent").locator(".portrait-card-info small"),
    ).toHaveText("Отец");
    await expect(
      card(page, "child").locator(".portrait-card-info small"),
    ).toHaveText("Это вы");
    expect(reads).toContain("/a/foreign-archive/api/family");
    expect(reads.filter((path) => path === "/api/family")).toEqual([]);
  });
}

for (const reference of [undefined, "person-only-in-own-archive"]) {
  test(`foreign archive hides kinship when account card is ${reference ? "absent" : "unbound"}`, async ({
    page,
  }) => {
    await mockArchives(page, reference, "reader");
    await page.goto("/a/foreign-archive/tree");
    await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
    await expect(card(page, "parent")).toBeVisible();
    await expect(card(page, "child")).toBeVisible();
    await expect(page.locator(".portrait-card-info small")).toHaveCount(0);
    await card(page, "parent").locator(".flow-person-content").click();
    await expect(card(page, "parent")).toHaveClass(/is-selected/);
    await expect(page.locator(".portrait-card-info small")).toHaveCount(0);
    await expect(card(page, "parent")).not.toContainText(
      /Это вы|Родство не установлено|Нет привязки/,
    );
  });
}
