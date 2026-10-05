import { expect, test, type Page } from "@playwright/test";
import type { ArchiveUser } from "../../src/domain/access.ts";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences.ts";
import type { Family } from "../../src/domain/types.ts";

const reader: ArchiveUser = {
  id: "reader",
  name: "Читатель",
  role: "reader",
  treeRole: "reader",
  archiveOwner: false,
  approved: true,
  createdAt: "2026-10-05",
  treeAccess: "all",
};
const family: Family = {
  title: "Древо участника",
  description: "",
  demo: false,
  people: [
    {
      id: "parent",
      name: "Иван",
      surname: "Тестов",
      patronymic: "",
      sex: "m",
      birth: "1940",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      generation: 1,
      column: 0,
    },
    {
      id: "child",
      name: "Пётр",
      surname: "Тестов",
      patronymic: "",
      sex: "m",
      birth: "1965",
      birthPlace: "",
      parents: ["parent"],
      spouses: [],
      sources: [],
      generation: 2,
      column: 0,
    },
  ],
  photos: [],
  links: [],
  unions: [],
};

async function mockReader(
  page: Page,
  prefix: string,
  initial: TreePreferences | null,
) {
  let preferences = initial;
  const writes: Array<{ path: string; value: TreePreferences }> = [];
  const mutations: string[] = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    localStorage.setItem(
      "drevo:guest-tree-preferences:v1",
      JSON.stringify({ reverseTimeline: true, colorScheme: "white" }),
    ),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method())) mutations.push(path);
    if (path === `${prefix}/api/tree-preferences`) {
      if (request.method() === "PUT") {
        const value = request.postDataJSON() as TreePreferences;
        writes.push({ path, value });
        preferences = { ...value };
        if (preferences.generationLimits === null)
          delete preferences.generationLimits;
      }
      return route.fulfill({ json: preferences || DEFAULT_TREE_PREFERENCES });
    }
    if (path === `${prefix}/api/family`)
      return route.fulfill({
        json: {
          family,
          user: reader,
          revision: 1,
          local: false,
          canEdit: false,
          readTree: true,
          readPhotos: true,
          treePreferences: preferences,
          reverseTimeline: true,
        },
      });
    if (path === `${prefix}/api/session`)
      return route.fulfill({
        json: {
          user: reader,
          local: false,
          account: {
            id: reader.id,
            name: reader.name,
            createdAt: reader.createdAt,
          },
        },
      });
    return route.fulfill({ json: { items: [], comments: [], categories: [] } });
  });
  return { writes, mutations, saved: () => preferences };
}

for (const prefix of ["", "/a/foreign-archive"]) {
  test(`reader can configure its own view with ancestors above by default (${prefix || "primary"})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const state = await mockReader(page, prefix, null);
    await page.goto(`${prefix}/tree`);
    const parent = page
      .locator('.flow-person[data-person-id="parent"]')
      .first();
    const child = page.locator('.flow-person[data-person-id="child"]').first();
    await expect(parent).toBeVisible();
    await expect(child).toBeVisible();
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-growing|is-layout-settling|theme-white/,
    );
    expect((await parent.boundingBox())!.y).toBeLessThan(
      (await child.boundingBox())!.y,
    );
    await page.getByRole("button", { name: "Настройки древа" }).click();
    const dialog = page.getByRole("dialog", { name: "Вид древа" });
    await expect(
      dialog.getByRole("radio", { name: "Предки сверху" }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("button", { name: "Управление древом" }),
    ).toHaveCount(0);
    await expect(page.locator(".flow-add-tools")).toHaveCount(0);
    await dialog.getByRole("radio", { name: "Белая" }).check();
    await expect(page.locator(".tree-canvas")).toHaveClass(/theme-white/);
    await dialog.getByRole("radio", { name: "Потомки сверху" }).check();
    await expect
      .poll(
        async () =>
          (await parent.boundingBox())!.y > (await child.boundingBox())!.y,
      )
      .toBe(true);
    await page.reload();
    await expect(page.locator(".tree-canvas")).toHaveClass(/theme-white/);
    await page.getByRole("button", { name: "Настройки древа" }).click();
    await expect(
      dialog.getByRole("radio", { name: "Потомки сверху" }),
    ).toBeChecked();
    await dialog
      .getByRole("switch", { name: "Ограничить видимое древо" })
      .check();
    await expect(
      dialog.getByRole("switch", { name: "Ограничить видимое древо" }),
    ).toBeChecked();
    await dialog.getByRole("button", { name: "Сбросить вид" }).click();
    await expect(
      dialog.getByRole("radio", { name: "Предки сверху" }),
    ).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Тёплая" })).toBeChecked();
    await expect(
      dialog.getByRole("switch", { name: "Ограничить видимое древо" }),
    ).not.toBeChecked();
    expect(state.writes.at(-1)).toEqual({
      path: `${prefix}/api/tree-preferences`,
      value: { ...DEFAULT_TREE_PREFERENCES, generationLimits: null },
    });
    expect(state.saved()).toEqual(DEFAULT_TREE_PREFERENCES);
    await page.reload();
    await expect(parent).toBeVisible();
    await expect(child).toBeVisible();
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-growing|is-layout-settling|theme-white/,
    );
    expect((await parent.boundingBox())!.y).toBeLessThan(
      (await child.boundingBox())!.y,
    );
    expect(
      state.mutations.every(
        (path) => path === `${prefix}/api/tree-preferences`,
      ),
    ).toBe(true);
    if (isMobile) await page.setViewportSize({ width: 320, height: 640 });
    await page.getByRole("button", { name: "Настройки древа" }).click();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    const reset = (await dialog
      .getByRole("button", { name: "Сбросить вид" })
      .boundingBox())!;
    const close = (await dialog
      .getByRole("button", { name: "Закрыть" })
      .boundingBox())!;
    expect(reset.x + reset.width).toBeLessThanOrEqual(close.x);
    await dialog.screenshot({
      path: testInfo.outputPath("reader-tree-settings.png"),
    });
  });
}
