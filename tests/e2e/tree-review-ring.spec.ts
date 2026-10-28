import { expect, test } from "@playwright/test";

test("portrait review borders retain their proportional width at distant zoom levels", async ({ page, isMobile }) => {
  await page.addInitScript(() => {
    const rings: number[] = [];
    Object.assign(window, { __reviewRings: rings });
    const radii = new WeakMap<CanvasRenderingContext2D, number>();
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function (...args) {
      radii.set(this, args[2]);
      return arc.apply(this, args);
    };
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (...args: [] | [Path2D]) {
      const radius = radii.get(this);
      if (this.canvas.classList.contains("tree-distant-portraits") &&
          this.strokeStyle === "#d77b18" && radius)
        rings.push(this.lineWidth / (2 * radius));
      return Reflect.apply(stroke, this, args);
    };
  });
  await page.route("**/api/family?projection=overview", async route => {
    const response = await route.fetch(), data = await response.json();
    for (const person of data.family.people) {
      person.needsReview = true;
      person.photo = "/media/review-ring.png";
    }
    await route.fulfill({ response, json: data });
  });
  await page.route("**/media/review-ring.png**", route => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#738273"/></svg>',
  }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  const out = page.getByRole("button", { name: "Уменьшить", exact: true });
  const pinchOut = async () => {
    const box = (await page.locator(".tree-canvas").boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height * 0.6;
    const session = await page.context().newCDPSession(page);
    const points = (distance: number) => [{ x: x - distance, y, id: 1 }, { x: x + distance, y, id: 2 }];
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(90) });
    for (let step = 1; step <= 12; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(90 - step * 6) });
      await page.waitForTimeout(16);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
  };
  if (isMobile) await pinchOut();
  else for (let index = 0; index < 12; index++) await out.click();
  const canvas = page.locator("canvas.tree-distant-portraits");
  await expect(canvas).toBeVisible();
  const ratios = () => page.evaluate(() =>
    (window as typeof window & { __reviewRings: number[] }).__reviewRings);
  await expect.poll(async () => (await ratios()).length).toBeGreaterThan(0);
  const first = (await ratios()).at(-1)!;
  await page.evaluate(() => { (window as typeof window & { __reviewRings: number[] }).__reviewRings.length = 0; });
  if (isMobile) await pinchOut();
  else for (let index = 0; index < 3; index++) await out.click();
  await expect.poll(async () => (await ratios()).length).toBeGreaterThan(0);
  expect((await ratios()).at(-1)!).toBeCloseTo(first, 3);
  expect(first).toBeCloseTo(3 / 129, 3);
});
