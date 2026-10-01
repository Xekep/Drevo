import { expect, test } from "@playwright/test";

test("chronology accepts a click immediately after its startup control becomes enabled", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    let sawDisabled = false;
    const observer = new MutationObserver(() => {
      const control = [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".tree-mode-bar button",
        ),
      ].find(
        (button) =>
          button.getAttribute("role") === "switch" ||
          button.textContent?.trim() === "Хронология",
      );
      if (!control) return;
      if (control.disabled) sawDisabled = true;
      else if (sawDisabled) {
        observer.disconnect();
        // Mutation observers run before the next paint, exposing stale native
        // capture listeners that a passive React effect has not replaced yet.
        control.click();
      }
    });
    observer.observe(document, {
      attributes: true,
      attributeFilter: ["disabled"],
      childList: true,
      subtree: true,
    });
  });
  await page.goto("/tree");
  await expect(
    page.getByRole("region", { name: /Горизонтальная хронология/ }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1940");
});
