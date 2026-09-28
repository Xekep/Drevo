import { expect, test, type Page } from "@playwright/test";

async function freezeGrowthBeforeFirstFrame(page: Page) {
  await page.addInitScript(() => {
    const install = () => {
      if (!document.documentElement) return false;
      const style = document.createElement("style");
      style.textContent = `
        .tree-canvas.is-growing .tree-grow-node,
        .tree-canvas.is-growing .tree-grow-surface,
        .tree-canvas.is-growing .tree-grow-node .flow-person,
        .tree-canvas.is-growing .tree-edge-growth-path {
          animation-play-state: paused !important;
        }
      `;
      document.documentElement.append(style);
      return true;
    };
    if (install()) return;
    const observer = new MutationObserver(() => {
      if (install()) observer.disconnect();
    });
    observer.observe(document, { childList: true });
  });
}

test("later-born descendants appear exactly when their incoming line finishes", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await freezeGrowthBeforeFirstFrame(page);
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveClass(/is-growing/);
  await expect(
    page.locator(".relationship-parent .tree-edge-growth-path"),
  ).not.toHaveCount(0);
  const timing = await canvas.evaluate((element) => {
    const card = [
      ...element.querySelectorAll<HTMLElement>(".tree-grow-node"),
    ].find((node) => getComputedStyle(node).animationDelay === "0.4s")!;
    const edge = [
      ...element.querySelectorAll<SVGGElement>(".relationship-parent"),
    ].find(
      (edge) =>
        edge.getAttribute("data-id")?.startsWith("child:") &&
        edge.getAttribute("data-id")?.includes("e2e-sibling"),
    )!;
    const line = edge.querySelector<SVGPathElement>(".tree-edge-growth-path")!;
    element.getAnimations({ subtree: true }).forEach((animation) => {
      animation.pause();
      animation.currentTime = 370;
    });
    const style = getComputedStyle(line);
    return {
      cardStarts: parseFloat(getComputedStyle(card).animationDelay),
      lineEnds:
        parseFloat(style.animationDelay) + parseFloat(style.animationDuration),
      lineRemaining: parseFloat(style.strokeDashoffset),
      cardOpacity: Number(getComputedStyle(card).opacity),
    };
  });
  expect(timing.lineEnds).toBeCloseTo(timing.cardStarts, 3);
  expect(timing.lineRemaining).toBeGreaterThan(0);
  expect(timing.lineRemaining).toBeLessThan(1);
  expect(timing.cardOpacity).toBe(0);
});

test("growth draws parent arrows before descendants without squeezing cards", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await freezeGrowthBeforeFirstFrame(page);
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveClass(/is-growing/);
  await expect(page.locator(".tree-grow-node")).toHaveCount(6);
  await expect(
    page.locator(".relationship-parent .tree-edge-growth-path"),
  ).not.toHaveCount(0);

  const phases = await canvas.evaluate((element) => {
    const animations = element
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation instanceof CSSAnimation &&
          ["tree-branch-reveal", "tree-card-grow", "tree-edge-draw"].includes(
            animation.animationName,
          ),
      );
    animations.forEach((animation) => animation.pause());
    const nodes = [...element.querySelectorAll<HTMLElement>(".tree-grow-node")];
    const firstDescendant = nodes.find(
      (node) => getComputedStyle(node).animationDelay === "0.34s",
    )!;
    const lastDescendant = nodes.find(
      (node) => getComputedStyle(node).animationDelay === "0.74s",
    )!;
    const card = firstDescendant.querySelector<HTMLElement>(".flow-person")!;
    const parentLine = [
      ...element.querySelectorAll<SVGPathElement>(
        ".relationship-parent .tree-edge-growth-path",
      ),
    ].find((path) => getComputedStyle(path).animationDelay === "0.1s")!;
    const parentFinal = parentLine
      .closest(".react-flow__edge")!
      .querySelector<SVGPathElement>(".tree-edge-final-path")!;
    const sample = (time: number) => {
      animations.forEach((animation) => {
        animation.currentTime = time;
      });
      const transform = new DOMMatrix(getComputedStyle(card).transform);
      return {
        childOpacity: Number(getComputedStyle(firstDescendant).opacity),
        laterOpacity: Number(getComputedStyle(lastDescendant).opacity),
        lineOffset: Number.parseFloat(
          getComputedStyle(parentLine).strokeDashoffset,
        ),
        finalOpacity: Number(getComputedStyle(parentFinal).opacity),
        cardWidth: card.getBoundingClientRect().width,
        cardHeight: card.getBoundingClientRect().height,
        cardScaleX: transform.a,
        cardScaleY: transform.d,
      };
    };
    return {
      line: sample(220),
      child: sample(450),
      nextArrow: sample(650),
      nextChild: sample(800),
    };
  });
  expect(phases.line.childOpacity).toBe(0);
  expect(phases.line.finalOpacity).toBe(0);
  expect(phases.line.lineOffset).toBeGreaterThan(0);
  expect(phases.line.lineOffset).toBeLessThan(1);
  expect(phases.child.childOpacity).toBeGreaterThan(0);
  expect(phases.child.laterOpacity).toBe(0);
  expect(phases.nextArrow.laterOpacity).toBe(0);
  expect(phases.nextChild.laterOpacity).toBeGreaterThan(0);
  for (const phase of Object.values(phases)) {
    expect(phase.cardWidth).toBeCloseTo(phases.child.cardWidth, 1);
    expect(phase.cardHeight).toBeCloseTo(phases.child.cardHeight, 1);
    expect(phase.cardScaleX).toBeCloseTo(1, 3);
    expect(phase.cardScaleY).toBeCloseTo(1, 3);
  }
});
