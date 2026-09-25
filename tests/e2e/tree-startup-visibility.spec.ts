import { expect, test } from "@playwright/test";

test("the initial tree remains hidden until branch animation starts", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
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
  expect(Number(samples[firstVisible].opacity)).toBeLessThan(0.1);
});
