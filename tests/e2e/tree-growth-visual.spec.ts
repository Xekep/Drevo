import { expect, test } from "@playwright/test";

test("growth draws parent arrows before descendants without squeezing cards", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveClass(/is-growing/);
  await expect(page.locator(".tree-grow-node")).toHaveCount(7);
  await expect(
    page.locator(".relationship-parent .tree-edge-growth-path"),
  ).not.toHaveCount(0);

  const phases = await canvas.evaluate((element) => {
    const animations = element
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation instanceof CSSAnimation &&
          [
            "tree-branch-reveal",
            "tree-card-grow",
            "tree-edge-draw",
            "tree-edge-final-reveal",
          ].includes(animation.animationName),
      );
    animations.forEach((animation) => animation.pause());
    const nodes = [...element.querySelectorAll<HTMLElement>(".tree-grow-node")];
    const firstDescendant = nodes.find(
      (node) => getComputedStyle(node).animationDelay === "0.52s",
    )!;
    const lastDescendant = nodes.find(
      (node) => getComputedStyle(node).animationDelay === "1.1s",
    )!;
    const card = firstDescendant.querySelector<HTMLElement>(".flow-person")!;
    const parentLine = [
      ...element.querySelectorAll<SVGPathElement>(
        ".relationship-parent .tree-edge-growth-path",
      ),
    ].find((path) => getComputedStyle(path).animationDelay === "0.28s")!;
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
      line: sample(400),
      child: sample(650),
      nextArrow: sample(950),
      nextChild: sample(1_180),
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
