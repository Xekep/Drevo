import { expect, test } from "@playwright/test";

test("a direct person link skips tree growth and smoothly focuses the requested person", async ({
  page,
}) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = "e2e-memorial-person";
    await route.fulfill({ response, json: data });
  });
  await page.addInitScript(() => {
    const samples: Array<{ growing: boolean; transform: string }> = [];
    Object.assign(window, { __directTreeSamples: samples });
    const start = performance.now();
    const tick = () => {
      const canvas = document.querySelector(".tree-canvas");
      const viewport = document.querySelector<HTMLElement>(
        ".react-flow__viewport",
      );
      if (canvas && viewport)
        samples.push({
          growing: /is-grow/.test(canvas.className),
          transform: viewport.style.transform,
        });
      if (performance.now() - start < 8000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto("/people/e2e-sibling");
  await expect(page.locator(".inspector-dock")).toContainText("Мария");
  const card = page.getByTestId("rf__node-e2e-sibling");
  await expect(card).toHaveClass(/selected/);
  await expect
    .poll(async () =>
      card.evaluate((element) => {
        const canvas = element.closest(".react-flow")!.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return Math.abs(rect.x + rect.width / 2 - canvas.x - canvas.width / 2);
      }),
    )
    .toBeLessThan(3);
  const samples = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __directTreeSamples: Array<{ growing: boolean; transform: string }>;
        }
      ).__directTreeSamples,
  );
  expect(samples.length).toBeGreaterThan(0);
  expect(samples.some((sample) => sample.growing)).toBe(false);
  expect(
    new Set(samples.map((sample) => sample.transform)).size,
  ).toBeGreaterThan(3);
  await expect(card.locator(".flow-person")).toHaveCSS("opacity", "1");
});

test("a person selected during tree growth waits for the animation before opening the side panel", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveClass(/is-growing/);
  // Navigation from outside the locked canvas (e.g. search/history) still
  // selects the person, but must not resize the canvas mid-animation.
  await page.evaluate(() => {
    window.history.pushState(null, "", "/people/e2e-sibling");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByTestId("rf__node-e2e-sibling")).toHaveClass(
    /selected/,
  );
  await expect(canvas).toHaveClass(/is-growing/);
  await expect(page.locator(".inspector-dock")).toHaveCount(0);
  await expect(canvas).not.toHaveClass(/is-grow/);
  await expect(page.locator(".inspector-dock")).toContainText("Мария");
});

for (const warmCache of [false, true])
  test(`the initial tree remains hidden until branch animation starts (${warmCache ? "cached" : "fresh"})`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    if (warmCache) {
      await page.goto("/tree");
      await expect(page.getByTestId("rf__node-e2e-child")).toBeAttached();
      await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
    }
    await page.addInitScript(() => {
      const samples: Array<Record<string, unknown>> = [];
      Object.assign(window, { __treeSamples: samples });
      const start = performance.now();
      const tick = () => {
        const canvas = document.querySelector<HTMLElement>(".tree-canvas");
        const viewport = document.querySelector<HTMLElement>(
          ".react-flow__viewport",
        );
        const card = document.querySelector<HTMLElement>(".tree-grow-node");
        if (canvas && viewport && card) {
          const style = getComputedStyle(card);
          const person = card.querySelector<HTMLElement>(".flow-person");
          let paintedOpacity = 1;
          for (
            let node: Element | null = person;
            node;
            node = node.parentElement
          ) {
            const computed = getComputedStyle(node);
            paintedOpacity *= Number(computed.opacity);
            if (computed.display === "none") paintedOpacity = 0;
          }
          if (person && getComputedStyle(person).visibility !== "visible")
            paintedOpacity = 0;
          samples.push({
            t: Math.round(performance.now() - start),
            className: canvas.className,
            viewportVisibility: getComputedStyle(viewport).visibility,
            opacity: style.opacity,
            animation: style.animationName,
            personOpacity: person ? getComputedStyle(person).opacity : null,
            cards: document.querySelectorAll(".tree-grow-node").length,
            paintedOpacity,
          });
        }
        if (performance.now() - start < 3500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto("/tree");
    await page.waitForTimeout(3600);
    const samples = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __treeSamples: Array<Record<string, unknown>>;
          }
        ).__treeSamples,
    );
    const firstVisible = samples.findIndex(
      (item) => item.viewportVisibility === "visible",
    );
    const preparing = samples.filter((item) =>
      String(item.className).includes("is-growth-preparing"),
    );
    expect(preparing.length).toBeGreaterThan(0);
    expect(preparing.every((item) => item.paintedOpacity === 0)).toBe(true);
    expect(firstVisible).toBeGreaterThan(0);
    expect(
      samples
        .slice(0, firstVisible)
        .every((item) => item.viewportVisibility === "hidden"),
    ).toBe(true);
    expect(samples[firstVisible].className).toContain("is-growing");
    // The first sampled frame may already be one 60 Hz step into the reveal.
    expect(Number(samples[firstVisible].opacity)).toBeLessThan(0.25);
  });
