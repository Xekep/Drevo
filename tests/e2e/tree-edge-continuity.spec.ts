import { expect, test } from "@playwright/test";

test("an empty archive does not lock the first-person action", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.family = { ...data.family, people: [], photos: [], links: [] };
    data.partial = false;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Добавить первого человека" }).click();
  await expect(
    page.getByRole("heading", { name: "Новый человек" }),
  ).toBeVisible();
});

for (const scenario of ["idle", "mouse", "large"] as const) {
  test(`drawn arrows stay visible during growth: ${scenario}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    if (scenario === "large") {
      await page.route("**/api/family?projection=overview", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        data.family.people = Array.from({ length: 600 }, (_, index) => ({
          id: `growth-${index}`,
          name: `Человек ${index}`,
          surname: "Тестовый",
          sex: "m",
          birth: `${1700 + (index % 12) * 24}-01-01`,
          patronymic: "",
          birthPlace: "",
          parents: index % 12 ? [`growth-${index - 1}`] : [],
          spouses: [],
          sources: [],
          generation: (index % 12) + 1,
          column: Math.floor(index / 12),
        }));
        data.family.links = [];
        data.family.photos = [];
        data.partial = false;
        data.user.personId = null;
        await route.fulfill({ response, json: data });
      });
    }
    await page.addInitScript(() => {
      const state = {
        lost: [] as string[],
        seen: new Set<string>(),
        frames: 0,
        details: [] as unknown[],
      };
      Object.assign(window, { __edgeContinuity: state });
      let started = false;
      const sample = () => {
        const canvas = document.querySelector(".tree-canvas");
        if (
          canvas?.classList.contains("is-growing") &&
          !canvas.classList.contains("is-growth-preparing")
        ) {
          started = true;
          state.frames++;
          for (const edge of canvas.querySelectorAll(".tree-grow-edge")) {
            const id = edge.getAttribute("data-id")!;
            const final = edge.querySelector(".tree-edge-final-path");
            const growth = edge.querySelector(".tree-edge-growth-path");
            if (!final || !growth) continue;
            const f = getComputedStyle(final),
              g = getComputedStyle(growth);
            const drawn =
              (Number(f.opacity) > 0.01 &&
                f.display !== "none" &&
                f.visibility === "visible") ||
              (Number(g.opacity) > 0.01 &&
                g.display !== "none" &&
                g.visibility === "visible" &&
                Number.parseFloat(g.strokeDashoffset) < 0.95);
            if (state.seen.has(id) && !drawn && !state.lost.includes(id)) {
              if (state.details.length < 3)
                state.details.push({
                  id,
                  at: performance.now(),
                  final: f.opacity,
                  growth: g.opacity,
                  offset: g.strokeDashoffset,
                  visibility: g.visibility,
                  animations: [
                    ...final.getAnimations(),
                    ...growth.getAnimations(),
                  ].map((a) => ({
                    start: a.startTime,
                    time: a.currentTime,
                    timing: a.effect?.getComputedTiming(),
                  })),
                });
              state.lost.push(id);
            }
            if (drawn) state.seen.add(id);
          }
        }
        if (!started || canvas?.classList.contains("is-growing"))
          requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.goto("/tree");
    const canvas = page.locator(".tree-canvas");
    await expect(canvas).toHaveClass(/is-growing/, { timeout: 15000 });
    await expect(canvas).not.toHaveClass(/is-growth-preparing/);
    const viewport = page.locator(".react-flow__viewport");
    const before = await viewport.getAttribute("style");
    if (scenario !== "idle") {
      const box = (await canvas.boundingBox())!;
      for (const button of ["left", "right", "middle"] as const) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down({ button });
        await page.mouse.move(
          box.x + box.width / 2 + 35,
          box.y + box.height / 2 + 25,
          { steps: 3 },
        );
        await page.mouse.up({ button });
      }
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, scenario === "large" ? -1000 : -240);
      if (scenario === "large") {
        await page.waitForTimeout(450);
        await page.mouse.wheel(0, 1000);
      }
      await page.keyboard.up("Control");
      await expect(viewport).toHaveAttribute("style", before!);
    }
    await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5000 });
    const result = await page.evaluate(() => {
      const state = (
        window as typeof window & {
          __edgeContinuity: {
            lost: string[];
            seen: Set<string>;
            frames: number;
            details: unknown[];
          };
        }
      ).__edgeContinuity;
      return {
        lost: state.lost,
        seen: state.seen.size,
        frames: state.frames,
        details: state.details,
      };
    });
    expect(result.frames).toBeGreaterThan(10);
    expect(result.seen).toBeGreaterThanOrEqual(scenario === "large" ? 10 : 6);
    expect(result.lost, JSON.stringify(result.details)).toEqual([]);
    if (scenario === "mouse") {
      // The lock must release after the intro, including its native listeners.
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -240);
      await page.keyboard.up("Control");
      await expect(viewport).not.toHaveAttribute("style", before!);
      await page
        .locator(".flow-camera-tools")
        .getByRole("button", { name: "Вписать видимую часть дерева" })
        .click();
      await page
        .getByTestId("rf__node-e2e-child")
        .locator(".flow-person-content")
        .click();
      await expect(page).toHaveURL(/\/people\/e2e-child$/);
    }
  });
}

test("the final arrow waits for actual drawing completion", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toHaveClass(/is-growing/);
  const edge = page.locator(".relationship-parent").first();
  const growth = edge.locator(".tree-edge-growth-path");
  await growth.evaluate((path) => {
    const animation = path.getAnimations()[0];
    const timing = animation.effect!.getComputedTiming();
    animation.pause();
    animation.currentTime = Number(timing.delay) + Number(timing.duration) / 2;
  });
  await page.waitForTimeout(600);
  await expect(edge.locator(".tree-edge-final-path")).toHaveCSS("opacity", "0");
  await expect(growth).toHaveCSS("opacity", "1");
  await growth.evaluate((path) => path.getAnimations()[0].play());
  await expect(edge.locator(".tree-grow-edge-visual")).toHaveClass(
    /is-growth-complete/,
  );
  await expect(edge.locator(".tree-edge-final-path")).toHaveCSS("opacity", "1");
  await expect(growth).toHaveCSS("display", "none");
});
