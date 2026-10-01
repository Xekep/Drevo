import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = "e2e-memorial-person";
    await route.fulfill({ response, json: data });
  });
});

async function waitForFlight(page: Page) {
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toHaveClass(/is-growing/);
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector(".tree-canvas");
      const viewport = document.querySelector<HTMLElement>(
        ".react-flow__viewport",
      );
      const state = window as typeof window & { __personalViewport?: string };
      if (!canvas || !viewport) return false;
      const current = viewport.style.transform;
      const moving =
        !canvas.classList.contains("is-growing") &&
        state.__personalViewport !== undefined &&
        state.__personalViewport !== current;
      state.__personalViewport = current;
      return moving;
    },
    null,
    { polling: "raf" },
  );
}

async function expectCentered(page: Page) {
  await expect
    .poll(() =>
      page
        .locator(".react-flow__viewport")
        .evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).a),
    )
    .toBeCloseTo(0.55, 2);
  await expect
    .poll(async () =>
      page.getByTestId("rf__node-e2e-memorial-person").evaluate((card) => {
        const viewport = card.closest(".react-flow")!.getBoundingClientRect();
        const person = card.getBoundingClientRect();
        return Math.hypot(
          person.x + person.width / 2 - viewport.x - viewport.width / 2,
          person.y + person.height / 2 - viewport.y - viewport.height / 2,
        );
      }),
    )
    .toBeLessThan(5);
}

test("the whole tree draws at a steady overview scale before the personal zoom", async ({
  page,
}, info) => {
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  const viewport = page.locator(".react-flow__viewport");
  await expect(canvas).toHaveClass(/is-growing/);
  const overview = await viewport.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform).a,
  );
  expect(overview).toBeLessThanOrEqual(
    info.project.name === "mobile" ? 0.32 : 0.38,
  );
  const transform = await viewport.getAttribute("style");
  await page.waitForTimeout(120);
  await expect(viewport).toHaveAttribute("style", transform!);
  await expect(canvas).not.toHaveClass(/is-grow/, { timeout: 5_000 });
  await expectCentered(page);
});

test("incidental background clicks during personal intro still finish at the account card", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await waitForFlight(page);
  const box = (await page.locator(".tree-canvas").boundingBox())!;
  await page.mouse.move(box.x + 25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2 + 25);
  await page.mouse.up();
  await expectCentered(page);
});

test("personal intro reaches the card without any input on fresh and cached loads", async ({
  page,
}) => {
  for (let load = 0; load < 3; load++) {
    await page.goto("/tree");
    await expectCentered(page);
    // Wait past the flight duration to catch a later camera effect taking over.
    await page.waitForTimeout(750);
    await expectCentered(page);
  }
});

test("resizing during personal intro finishes at the new viewport center", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await waitForFlight(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await expectCentered(page);
  await page.waitForTimeout(750);
  await expectCentered(page);
});

test("reduced motion still centers the account card", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await expectCentered(page);
});
