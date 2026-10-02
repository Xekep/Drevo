import { expect, test, type Page } from "@playwright/test";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences";

async function preferencesFixture(page: Page) {
  let preferences: TreePreferences = {
    ...DEFAULT_TREE_PREFERENCES,
    generationLimits: {
      anchorId: "e2e-child",
      ancestors: 7,
      descendants: 50,
      collateral: 2,
    },
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), treePreferences: preferences },
    });
  });
  await page.route("**/api/tree-preferences", async (route) => {
    if (route.request().method() === "PUT")
      preferences = route.request().postDataJSON();
    await route.fulfill({ json: preferences });
  });
}

async function expectCentered(page: Page, id: string) {
  await expect
    .poll(
      async () => {
        const stage = await page.locator(".react-flow").boundingBox();
        const node = await page
          .locator(
            `.react-flow__node:has(.flow-person[data-person-id="${id}"])`,
          )
          .first()
          .boundingBox();
        if (!stage || !node) return Infinity;
        return Math.max(
          Math.abs(node.x + node.width / 2 - (stage.x + stage.width / 2)),
          Math.abs(node.y + node.height / 2 - (stage.y + stage.height / 2)),
        );
      },
      { timeout: 15_000 },
    )
    .toBeLessThan(12);
}

async function pan(page: Page) {
  const stage = (await page.locator(".react-flow").boundingBox())!;
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  await page.mouse.move(
    stage.x + stage.width - 35,
    stage.y + stage.height - 100,
  );
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(
    stage.x + stage.width - 175,
    stage.y + stage.height - 180,
    { steps: 5 },
  );
  await page.mouse.up({ button: "middle" });
  await expect(viewport).not.toHaveAttribute("style", before!);
}

async function settings(page: Page) {
  await page.getByRole("button", { name: "Настройки древа" }).click();
  return page.getByRole("dialog", { name: "Вид древа" });
}

test("scope and anchor changes center the current anchor, even with unchanged geometry", async ({
  page,
  isMobile,
}) => {
  await preferencesFixture(page);
  if (!isMobile) await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/tree");
  await expect(page.locator(".flow-person")).toHaveCount(6);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-growing|is-layout-settling/,
  );
  await pan(page);
  let dialog = await settings(page);
  await dialog
    .getByRole("radio", { name: "Боковые ветви: 0", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expect(page.locator(".flow-person")).toHaveCount(4);
  await expectCentered(page, "e2e-child");

  dialog = await settings(page);
  await dialog
    .getByRole("combobox", { name: "Относительно человека" })
    .selectOption("e2e-grandchild");
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expectCentered(page, "e2e-grandchild");

  await pan(page);
  dialog = await settings(page);
  await dialog.getByRole("radio", { name: "Вверх: 4", exact: true }).check();
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expect(page.locator(".flow-person")).toHaveCount(4);
  await expectCentered(page, "e2e-grandchild");

  dialog = await settings(page);
  await dialog
    .getByRole("switch", { name: "Ограничить видимое древо" })
    .uncheck();
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expect(page.locator(".flow-person")).toHaveCount(6);
  await expectCentered(page, "e2e-grandchild");

  // A later explicit selection must win over the remembered scope request.
  await page
    .getByRole("combobox", { name: "Найти человека или документ" })
    .fill("Пётр");
  await page.getByRole("option", { name: /Тестов Пётр/ }).click();
  await expectCentered(page, "e2e-child");
  if (!isMobile) {
    // Selecting a card clears explicit focus, but must not revive the old anchor.
    // On mobile the inspector is a modal covering the card.
    await page
      .locator('.flow-person[data-person-id="e2e-child"] .flow-person-content')
      .first()
      .click();
    await expectCentered(page, "e2e-child");
    await page
      .locator(
        '.flow-person[data-person-id="e2e-sibling"] .flow-person-content',
      )
      .first()
      .click({ button: "middle" });
    await expectCentered(page, "e2e-sibling");
  }
});

test("opening a card after scope focus preserves the camera through inspector resizes", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop inspector changes the width of the tree canvas");
  await preferencesFixture(page);
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  const viewport = page.locator(".react-flow__viewport");
  await expect(page.locator(".flow-person")).toHaveCount(6);
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  let dialog = await settings(page);
  await dialog
    .getByRole("radio", { name: "Боковые ветви: 0", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expect(page.locator(".flow-person")).toHaveCount(4);
  await expectCentered(page, "e2e-child");
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  await pan(page);
  const before = await viewport.getAttribute("style");
  const spouse = page
    .locator('.react-flow__node:has(.flow-person[data-person-id="e2e-spouse"])')
    .first();

  // Do not search or navigate first: that would clear the remembered scope focus.
  for (let opening = 0; opening < 2; opening++) {
    await spouse.locator(".flow-person-content").click();
    await expect(page).toHaveURL(/\/people\/e2e-spouse$/);
    await expect(spouse).toHaveClass(/selected/);
    const close = page.getByRole("button", {
      name: "Закрыть панель",
      exact: true,
    });
    await expect(close).toBeVisible();
    await page.waitForTimeout(900);
    expect(await viewport.getAttribute("style")).toBe(before);
    await close.click();
    await expect(page).toHaveURL(/\/tree$/);
    await expect(close).not.toBeVisible();
    await page.waitForTimeout(900);
    expect(await viewport.getAttribute("style")).toBe(before);
  }

  // Cancelling an old scope request must not disable future explicit scope changes.
  dialog = await settings(page);
  await dialog.getByRole("radio", { name: "Вверх: 4", exact: true }).check();
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expectCentered(page, "e2e-child");
  await pan(page);
  const afterScopePan = await viewport.getAttribute("style");
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width - 80, height: size.height });
  await page.waitForTimeout(900);
  expect(await viewport.getAttribute("style")).toBe(afterScopePan);
});

test("opening a card cancels scope focus while its Worker layout is pending", async ({
  page,
}) => {
  await preferencesFixture(page);
  await page.addInitScript(() => {
    let held = false;
    Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
      apply(target, thisArg, args) {
        if (!held && args[0]?.people?.length === 4) {
          held = true;
          Object.assign(window, {
            releaseCardScopeLayout: () => Reflect.apply(target, thisArg, args),
          });
          return;
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  const viewport = page.locator(".react-flow__viewport");
  await expect(page.locator(".flow-person")).toHaveCount(6);
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  await pan(page);
  const before = await viewport.getAttribute("style");
  const dialog = await settings(page);
  await dialog
    .getByRole("radio", { name: "Боковые ветви: 0", exact: true })
    .check();
  await expect
    .poll(() => page.evaluate(() => "releaseCardScopeLayout" in window))
    .toBe(true);
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await page
    .locator('.flow-person[data-person-id="e2e-spouse"] .flow-person-content')
    .first()
    .click();
  await expect(page).toHaveURL(/\/people\/e2e-spouse$/);
  await expect(
    page.getByRole("button", { name: "Закрыть панель", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { releaseCardScopeLayout?: () => void }
    ).releaseCardScopeLayout!(),
  );
  await expect(page.locator(".flow-person")).toHaveCount(4);
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  await page.waitForTimeout(900);
  expect(await viewport.getAttribute("style")).toBe(before);
});

test("a pending layout cannot replace the camera target from a newer scope", async ({
  page,
}) => {
  await preferencesFixture(page);
  await page.addInitScript(() => {
    Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
      apply(target, thisArg, args) {
        if (args[0]?.people?.length === 4) {
          Object.assign(window, {
            releaseScopeLayout: () => Reflect.apply(target, thisArg, args),
          });
          return;
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  });
  await page.goto("/tree");
  await expect(page.locator(".flow-person")).toHaveCount(6);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-growing|is-layout-settling/,
  );
  await pan(page);
  const before = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  const dialog = await settings(page);
  await dialog
    .getByRole("radio", { name: "Боковые ветви: 0", exact: true })
    .check();
  await expect
    .poll(() => page.evaluate(() => "releaseScopeLayout" in window))
    .toBe(true);
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
    "style",
    before!,
  );
  await dialog
    .getByRole("combobox", { name: "Относительно человека" })
    .selectOption("e2e-spouse");
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expect(page.locator(".flow-person")).toHaveCount(2);
  await expectCentered(page, "e2e-spouse");
  await page.evaluate(() =>
    (window as Window & { releaseScopeLayout?: () => void })
      .releaseScopeLayout!(),
  );
  await expectCentered(page, "e2e-spouse");
});

test("an anchor chosen before the first layout is ready still receives camera focus", async ({
  page,
}) => {
  await preferencesFixture(page);
  await page.addInitScript(() => {
    Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
      apply(target, thisArg, args) {
        if (args[0]?.people?.length === 6) return;
        return Reflect.apply(target, thisArg, args);
      },
    });
  });
  await page.goto("/tree");
  const dialog = await settings(page);
  await dialog
    .getByRole("radio", { name: "Боковые ветви: 0", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expect(page.locator(".flow-person")).toHaveCount(4);
  await expectCentered(page, "e2e-child");
});
