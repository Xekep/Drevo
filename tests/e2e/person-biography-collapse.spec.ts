import { expect, test } from "@playwright/test";
import { e2eFamily } from "./base-family";

test("long life descriptions expand on demand and short descriptions remain complete", async ({ page }) => {
  await page.route("**/api/family?projection=overview", async route => {
    const response = await route.fetch(), data = await response.json();
    data.family = e2eFamily(data.family);
    data.partial = false;
    data.treePreferences = { ...data.treePreferences, animateOnLoad: false };
    data.family.people.find((p: { id: string }) => p.id === "e2e-child").biography =
      `Начало воспоминаний. ${"Собирал семейные истории и работал в школе. ".repeat(40)}\n\nПоследняя запись в биографии.`;
    data.family.people.find((p: { id: string }) => p.id === "e2e-memorial-person").biography = "Короткое описание жизни.";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/people/e2e-child");
  const panel = page.locator(".inspector-dock");
  const expand = panel.getByRole("button", { name: "Читать далее", exact: true });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(panel.locator(".person-biography-text")).toContainText("Начало воспоминаний.");
  await expect(panel.getByText("Последняя запись в биографии.", { exact: true })).toHaveCount(0);
  await expand.click();
  await expect(panel.getByText("Последняя запись в биографии.", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Свернуть", exact: true }).click();
  await expect(panel.getByText("Последняя запись в биографии.", { exact: true })).toHaveCount(0);
  await expect(expand).toBeInViewport();
  await page.goto("/people/e2e-memorial-person");
  await expect(panel.getByText("Короткое описание жизни.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Читать далее", exact: true })).toHaveCount(0);
});
