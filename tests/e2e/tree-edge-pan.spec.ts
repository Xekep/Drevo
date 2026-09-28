import { expect, test } from "@playwright/test";

test("dragging from a relationship arrow pans the tree without selecting it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/, {
    timeout: 5_000,
  });

  const edgePoint = () =>
    page.locator(".react-flow__edge-interaction").evaluateAll((paths) => {
      for (const path of paths) {
        if (!(path instanceof SVGPathElement)) continue;
        const middle = path.getPointAtLength(path.getTotalLength() / 2);
        const matrix = path.getScreenCTM();
        if (!matrix) continue;
        const point = new DOMPoint(middle.x, middle.y).matrixTransform(matrix);
        const hit = document.elementFromPoint(point.x, point.y);
        const edge = hit?.closest(".react-flow__edge");
        if (edge && path.closest(".react-flow__edge") === edge)
          return { x: point.x, y: point.y, id: edge.getAttribute("data-id") };
      }
      return null;
    });

  const point = await edgePoint();
  expect(point).not.toBeNull();
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.down();
  await page.mouse.move(point!.x + 60, point!.y + 45, { steps: 5 });
  await page.mouse.up();
  await expect(viewport).not.toHaveAttribute("style", before!);
  await expect(page.getByTestId(`rf__edge-${point!.id}`)).not.toHaveClass(
    /selected/,
  );

  const clickPoint = await edgePoint();
  expect(clickPoint).not.toBeNull();
  await page.mouse.click(clickPoint!.x, clickPoint!.y);
  await expect(page.getByTestId(`rf__edge-${clickPoint!.id}`)).toHaveClass(
    /selected/,
  );
});
