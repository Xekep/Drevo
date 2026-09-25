import { expect, test } from "@playwright/test";

test("award entrance animation replays when the same person is reopened", async ({
  page,
}) => {
  await page.goto("/people/e2e-child");
  const dock = page.locator(".inspector-dock");
  const medals = dock.locator(".award-visual");
  await expect(medals).toHaveCount(2);
  await expect(medals.first()).toHaveCSS(
    "animation-name",
    "award-medal-appear",
  );
  await expect(medals.nth(1)).toHaveCSS("animation-delay", "0.055s");

  await dock.getByRole("button", { name: "Закрыть панель" }).click();
  await expect(dock).toHaveCount(0);
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await expect(medals).toHaveCount(2);
  await expect(medals.first()).toHaveCSS(
    "animation-name",
    "award-medal-appear",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(medals.first()).toHaveCSS("animation-name", "none");
});
