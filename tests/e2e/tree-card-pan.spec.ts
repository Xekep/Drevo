import { expect, test } from "@playwright/test";

for (const variant of ["portrait", "classic"])
  test(`drag and wheel over a ${variant} card pan without opening the person`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/family?projection=overview", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.treePreferences = {
        reverseTimeline: false,
        cardVariant: variant,
        colorScheme: "warm",
      };
      data.family.people.find(
        (person: { id: string }) => person.id === "e2e-child",
      ).photo = "/favicon.svg";
      await route.fulfill({ response, json: data });
    });
    await page.goto("/tree");
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-grow|is-layout-settling/,
    );
    const node = page.getByTestId("rf__node-e2e-child");
    const card = node.locator(".flow-person-content");
    const viewport = page.locator(".react-flow__viewport");
    const camera = () =>
      viewport.evaluate((element) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return { x: matrix.e, y: matrix.f, zoom: matrix.a };
      });
    const before = await camera();
    const position = await node.getAttribute("style");
    const box = (await card.locator(".person-avatar").boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 70, y + 35, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => (await camera()).x - before.x)
      .toBeCloseTo(70, 0);
    expect((await camera()).y - before.y).toBeCloseTo(35, 0);
    expect((await camera()).zoom).toBe(before.zoom);
    await expect(node).toHaveAttribute("style", position!);
    await expect(page.locator(".inspector-dock")).toHaveCount(0);
    await expect(page).toHaveURL(/\/tree$/);
    await card.hover();
    const afterDrag = await camera();
    await page.mouse.wheel(0, 90);
    await expect
      .poll(async () => (await camera()).y)
      .toBeLessThan(afterDrag.y - 20);
    await expect(page.locator(".inspector-dock")).toHaveCount(0);
    await card.click();
    await expect(page.locator(".inspector-dock")).toBeVisible();
    await expect(page).toHaveURL(/\/people\/e2e-child$/);
  });

test("a touch drag starting on a card pans without selecting it", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-grow|is-layout-settling/,
  );
  const card = page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content");
  const box = (await card.boundingBox())!;
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  const session = await page.context().newCDPSession(page);
  const point = (dy: number) => [
    { x: box.x + box.width / 2, y: box.y + box.height / 2 + dy },
  ];
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: point(0),
  });
  for (const dy of [15, 30, 50, 70])
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: point(dy),
    });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await session.detach();
  await expect(viewport).not.toHaveAttribute("style", before!);
  await expect(page.locator(".flow-person.is-selected")).toHaveCount(0);
  await expect(page.locator(".inspector-dock")).toHaveCount(0);
});
