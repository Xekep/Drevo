import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes";
import type { Family } from "../../src/domain/types";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences";

for (const presentation of ["flat", "depth"] as const) {
  test(`editing a person preserves the limited tree anchor in ${presentation} view`, async ({ page, isMobile }) => {
    test.skip(isMobile && presentation === "depth", "3D editor regression uses the desktop inspector");

    await page.emulateMedia({ reducedMotion: "reduce" });
    const overviewResponse = await page.request.get("/api/family?projection=overview");
    const overview = await overviewResponse.json();
    let family = structuredClone((await (await page.request.get("/api/family")).json()).family) as Family;
    let revision = overview.revision as number;
    let preferences: TreePreferences = {
      ...DEFAULT_TREE_PREFERENCES,
      animateOnLoad: false,
      presentation: "flat",
      generationLimits: {
        anchorId: "e2e-sibling",
        ancestors: 7,
        descendants: 50,
        collateral: 2,
      },
    };
    const preferenceWrites: TreePreferences[] = [];

    await page.route("**/api/family?projection=overview", route => route.fulfill({
      response: overviewResponse,
      json: { ...overview, family, revision, partial: false, treePreferences: preferences },
    }));
    await page.route("**/api/tree-preferences", route => {
      if (route.request().method() === "PUT") {
        preferences = route.request().postDataJSON() as TreePreferences;
        preferenceWrites.push(preferences);
      }
      return route.fulfill({ json: preferences });
    });
    await page.route("**/api/family/changes", route => {
      const changes = route.request().postDataJSON().changes as Change[];
      const applied = applyArchiveChanges(family, changes);
      expect(applied.conflicts).toEqual([]);
      family = applied.family;
      return route.fulfill({ json: { family, revision: ++revision, appliedChanges: changes } });
    });

    await page.goto("/tree");
    const canvas = page.locator(".tree-canvas");
    const anchor = canvas.getByRole("status", { name: "Опорный человек" });
    await expect(anchor).toContainText("Тестова Мария Ивановна");

    // Selecting a different person is not an explicit request to change the scope.
    await page.locator('.flow-person[data-person-id="e2e-child"] .flow-person-content').first().click();
    const edit = page.locator(".inspector-person-actions .person-edit-button");
    await expect(edit).toBeVisible();

    if (presentation === "depth") {
      await page.getByRole("button", { name: "Настройки древа" }).click();
      const dialog = page.getByRole("dialog", { name: "Вид древа" });
      await dialog.getByRole("radio", { name: "3D", exact: true }).check();
      await dialog.getByRole("button", { name: "Закрыть" }).click();
      await expect(canvas).toHaveAttribute("data-depth-anchor", "e2e-sibling");
    }

    const writesBeforeSave = preferenceWrites.length;
    await edit.click();
    const form = page.locator(".person-editor-form");
    await expect(form.locator('[data-field="name"]')).toBeVisible();
    await form.getByLabel("Фамилия при рождении", { exact: true }).fill("Проверочная");
    await form.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect.poll(() => family.people.find(person => person.id === "e2e-child")?.maidenName)
      .toBe("Проверочная");

    // Neither the persisted generation reference nor the 3D camera anchor may follow an edit.
    expect(preferenceWrites).toHaveLength(writesBeforeSave);
    expect(preferences.generationLimits?.anchorId).toBe("e2e-sibling");
    await expect(anchor).toContainText("Тестова Мария Ивановна");
    if (presentation === "depth")
      await expect(canvas).toHaveAttribute("data-depth-anchor", "e2e-sibling");
  });
}
