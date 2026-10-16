import { test, expect } from "@playwright/test";
import type { Family, Person } from "../../src/domain/types.ts";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences.ts";

const p = (id: string, parents: string[] = []): Person => ({
  id,
  name: id,
  surname: "Тестов",
  patronymic: "",
  sex: "m",
  birth: "1970",
  birthPlace: "",
  parents,
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
});
const family: Family = {
  title: "Ветви",
  description: "",
  demo: false,
  photos: [],
  links: [],
  unions: [],
  people: [
    p("dad"),
    p("me", ["dad"]),
    p("child", ["me"]),
    p("sibling", ["dad"]),
    p("nephew", ["sibling"]),
    p("isolate"),
    p("distant-a"),
    p("distant-b"),
    p("distant-c"),
  ],
};

test("2.5D switches whole branches, leaves profiles in place and restores normal view", async ({
  page,
}, info) => {
  let preferences: TreePreferences = {
    ...DEFAULT_TREE_PREFERENCES,
    animateOnLoad: false,
  };
  const user = {
    id: "depth-user",
    name: "Участник",
    personId: "me",
    role: "reader",
    treeRole: "reader",
    approved: true,
    archiveOwner: false,
    treeAccess: "all",
    createdAt: "2026-10-15",
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/api/family"))
      return route.fulfill({
        json: {
          family,
          user,
          revision: 1,
          local: false,
          canEdit: false,
          readTree: true,
          readPhotos: true,
          treePreferences: preferences,
        },
      });
    if (path.endsWith("/api/session"))
      return route.fulfill({ json: { user, account: user, local: false } });
    if (path.endsWith("/api/tree-preferences")) {
      if (route.request().method() === "PUT")
        preferences = route.request().postDataJSON();
      return route.fulfill({ json: preferences });
    }
    return route.fulfill({
      json: { items: [], comments: [], unread: 0, categories: [] },
    });
  });
  await page.goto("/tree");
  const scene = page.locator(".tree-canvas");
  await expect(scene).toHaveAttribute("data-layout-ready", "true");
  await page
    .getByRole("button", { name: "Настройки древа", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await dialog.getByRole("radio", { name: "2.5D", exact: true }).check();
  await expect.poll(() => preferences.presentation).toBe("depth");
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(scene).toHaveAttribute("data-depth-anchor", "me");
  await expect(scene).toHaveAttribute("data-layout-people", "3");
  await expect(
    page.locator('.flow-person[data-person-id="sibling"]'),
  ).toHaveCount(0);
  const branch = page.getByRole("button", {
    name: /Перейти к ветви: Тестов sibling,/,
  });
  await expect(branch).toBeVisible();
  expect(await branch.evaluate((node) => !!node.closest(".react-flow__viewport"))).toBe(true);
  await expect(page.locator(".tree-depth-stack, .tree-depth-layers")).toHaveCount(0);
  const before = await branch.boundingBox();
  const pane = await page.locator(".react-flow").boundingBox();
  await page.mouse.move(pane!.x + 12, pane!.y + pane!.height - 12);
  await page.mouse.down();
  await page.mouse.move(pane!.x + 60, pane!.y + pane!.height - 36, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await branch.boundingBox())!.x - before!.x)).toBeGreaterThan(20);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("depth-branches.png") });
  await branch.focus();
  await page.keyboard.press("Enter");
  await expect(scene).toHaveAttribute("data-depth-anchor", "sibling");
  await expect(scene).toHaveAttribute("data-layout-ready", "true");
  await expect(
    page.getByRole("button", { name: "Предыдущая ветвь", exact: true }),
  ).toBeFocused();
  await expect(page.locator('.flow-person[data-person-id="me"]')).toHaveCount(
    0,
  );
  await expect(
    page.locator('.flow-person[data-person-id="nephew"]'),
  ).toHaveCount(1);
  await page
    .locator('.flow-person[data-person-id="dad"] .flow-person-content')
    .click();
  await expect(scene).toHaveAttribute("data-depth-anchor", "sibling");
  // The side panel can cover the scene on mobile. Close it before changing branches.
  await page
    .getByRole("button", { name: "Закрыть панель", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Предыдущая ветвь", exact: true })
    .click();
  await expect(scene).toHaveAttribute("data-depth-anchor", "me");
  // Rear cards are real pointer targets on the canvas, not just keyboard links.
  await page.getByRole("button", { name: /Перейти к ветви: Тестов sibling,/ }).click();
  await expect(scene).toHaveAttribute("data-depth-anchor", "sibling");
  await page.getByRole("button", { name: "Предыдущая ветвь", exact: true }).click();
  await expect(scene).toHaveAttribute("data-depth-anchor", "me");
  await page
    .getByRole("button", { name: "Настройки древа", exact: true })
    .click();
  await dialog.getByRole("radio", { name: "Обычное", exact: true }).check();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(scene).not.toHaveAttribute("data-depth-anchor");
  await expect(scene).toHaveAttribute("data-layout-people", "9");
});
