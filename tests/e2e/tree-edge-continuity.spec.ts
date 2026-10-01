import { expect, test } from "@playwright/test";

test("co-parents without marriage keep separate card backgrounds", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.family.people = data.family.people.map(
      (person: { id: string; spouses: string[]; parents: string[] }) =>
        person.id === "e2e-child" || person.id === "e2e-spouse"
          ? { ...person, spouses: [] }
          : person.id === "e2e-grandchild"
            ? { ...person, parents: ["e2e-child", "e2e-spouse"] }
            : person,
    );
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  for (const id of ["e2e-child", "e2e-spouse"]) {
    const card = page.getByTestId(`rf__node-${id}`).locator(".flow-person");
    await expect(card).toBeVisible();
    await expect(card).not.toHaveAttribute("data-household", "true");
  }
  await expect(
    page.locator(".react-flow__edge.relationship-parent"),
  ).not.toHaveCount(0);
});

test("adding a spouse offers the current person's child before saving", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  await page
    .getByTestId("rf__node-e2e-sibling")
    .locator(".flow-person-content")
    .click();
  await page.getByRole("button", { name: "Добавить родственника" }).click();
  await page.getByLabel("Кого добавить").selectOption("spouse");
  await page.getByRole("button", { name: "Новый человек" }).click();
  await page.getByRole("textbox", { name: /ФИО/ }).fill("Другой Иван");
  await expect(
    page.locator(".name-suggestions").getByText(/Возможный ребёнок.*Ольга/),
  ).toBeVisible();
});
test("new relative asks for an explicit twin type", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  await page
    .getByTestId("rf__node-e2e-sibling")
    .locator(".flow-person-content")
    .click();
  await page.getByRole("button", { name: "Добавить родственника" }).click();
  await page.getByLabel("Кого добавить").selectOption("spouse");
  await page.getByRole("button", { name: "Новый человек" }).click();
  await expect(page.getByLabel("Тип близнецов")).toHaveCount(0);
  const relation = page.getByLabel(/Кем новый человек приходится/);
  await expect(relation.locator('option[value="adoptive_parent"]')).toHaveText("Усыновитель");
  await expect(relation.locator('option[value="foster_parent"]')).toHaveText("Приёмный родитель");
  await expect(relation.locator('option[value="presumed_parent"]')).toHaveText("Предполагаемый родитель");
  await page.getByLabel(/Кем новый человек приходится/).selectOption("twin");
  await page.getByLabel("Тип близнецов").selectOption("fraternal");
  await expect(page.getByLabel("Тип близнецов")).toHaveValue("fraternal");
});

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
    await page.addInitScript((scenario) => {
      const state = {
        lost: [] as string[],
        seen: new Set<string>(),
        rechecked: new Set<string>(),
        frames: 0,
        blocked: 0,
        unblocked: 0,
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
          // Keep probes inside the animation frame: a slow CI runner can
          // finish the intro between separate Playwright mouse commands.
          // Large archives now have a shorter intro; probe its first frame
          // even when rendering the graph leaves fewer than five frames.
          if (
            scenario !== "idle" &&
            (state.frames === 1 || state.frames % 5 === 0)
          ) {
            const target = canvas.querySelector(".react-flow__pane")!;
            for (const event of [
              new WheelEvent("wheel", {
                ctrlKey: true,
                deltaY: state.frames % 10 ? -1000 : 1000,
                bubbles: true,
                cancelable: true,
              }),
              ...[0, 1, 2].map(
                (button) =>
                  new MouseEvent("mousedown", {
                    button,
                    bubbles: true,
                    cancelable: true,
                  }),
              ),
            ]) {
              if (target.dispatchEvent(event)) state.unblocked++;
              else state.blocked++;
            }
          }
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
            if (state.seen.has(id)) state.rechecked.add(id);
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
    }, scenario);
    await page.goto("/tree");
    const canvas = page.locator(".tree-canvas");
    await expect(canvas).toHaveClass(/is-growing/, { timeout: 15000 });
    await expect(canvas).not.toHaveClass(/is-growth-preparing/);
    const viewport = page.locator(".react-flow__viewport");
    const before = await viewport.getAttribute("style");
    if (scenario === "mouse") {
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
      await page.mouse.wheel(0, -240);
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
            rechecked: Set<string>;
            frames: number;
            blocked: number;
            unblocked: number;
            details: unknown[];
          };
        }
      ).__edgeContinuity;
      return {
        lost: state.lost,
        seen: state.seen.size,
        rechecked: state.rechecked.size,
        frames: state.frames,
        blocked: state.blocked,
        unblocked: state.unblocked,
        details: state.details,
      };
    });
    // Correctness must not depend on the CI machine's FPS. Require repeated
    // observations of distinct already-drawn edges, not an arbitrary frame rate.
    expect(result.frames).toBeGreaterThan(1);
    // The sixth fixture edge is an additional relation, hidden by default.
    expect(result.rechecked).toBeGreaterThanOrEqual(
      scenario === "large" ? 10 : 5,
    );
    expect(result.seen).toBeGreaterThanOrEqual(scenario === "large" ? 10 : 5);
    expect(result.lost, JSON.stringify(result.details)).toEqual([]);
    if (scenario !== "idle") {
      expect(result.blocked).toBeGreaterThan(0);
      expect(result.unblocked).toBe(0);
    }
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
