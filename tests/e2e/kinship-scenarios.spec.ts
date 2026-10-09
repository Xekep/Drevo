import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Family } from "../../src/domain/types.ts";

for (const [first, second, title, firstRole, secondRole] of [
  [
    "elena",
    "alexey",
    "Троюродное родство",
    "троюродная сестра",
    "троюродный брат",
  ],
  ["nikolai", "alexey", "Прямая линия родства", "прадедушка", "правнук"],
] as const)
  test(`режим родства: ${title}, правильное направление обеих ролей`, async ({
    page,
  }) => {
    const family = JSON.parse(
      readFileSync("tests/fixtures/family.json", "utf8"),
    ) as Family;
    const token = "k".repeat(43);
    await page.route(`**/api/shared/${token}`, (route) =>
      route.fulfill({
        json: {
          family,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          serverTime: new Date().toISOString(),
        },
      }),
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/s/${token}`);
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-grow|is-layout-settling/,
    );
    await page.getByRole("button", { name: "Родство", exact: true }).click();
    // Dispatch to the mounted cards: the full fixture extends past the mobile viewport.
    await page
      .getByTestId(`rf__node-${first}`)
      .locator(".flow-person-content")
      .dispatchEvent("click");
    await page
      .getByTestId(`rf__node-${second}`)
      .locator(".flow-person-content")
      .dispatchEvent("click");
    const result = page.locator(".relation-result");
    await expect(result.getByRole("heading")).toHaveText(title);
    await expect(
      result.locator(".relation-direction strong").nth(0),
    ).toHaveText(firstRole);
    await expect(
      result.locator(".relation-direction strong").nth(1),
    ).toHaveText(secondRole);
    if (title === "Прямая линия родства")
      await expect(page.locator(".kinship-path .common-ancestor")).toHaveCount(
        0,
      );
    else
      await expect(
        page.locator(".kinship-path .common-ancestor"),
      ).not.toHaveCount(0);
  });
