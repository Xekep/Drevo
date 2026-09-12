import { expect, test } from "@playwright/test";

test("production build opens the archive and navigates without console errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/");
  await expect(page).toHaveTitle(/Древо/);
  await expect(
    page.getByRole("navigation", { name: "Разделы архива" }),
  ).toBeVisible();
  const people = page.getByRole("button", { name: "Люди", exact: true });
  if (!(await people.isVisible()))
    await page.locator('summary[aria-label="Меню проекта"]').click();
  await people.click();
  await expect(page.getByRole("heading", { name: /Люди/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile archive does not overflow the viewport", async ({ page }) => {
  await page.goto("/tree");
  await expect(
    page.getByRole("navigation", { name: "Разделы архива" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the initial tree grows from roots toward descendants", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveClass(/is-growing/);
  const nodes = page.locator(".tree-grow-node");
  await expect(nodes).toHaveCount(3);
  const delays = await nodes.evaluateAll((items) =>
    items
      .map((item) => getComputedStyle(item).animationDelay)
      .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b)),
  );
  expect(delays).toEqual(["0s", "0.65s", "1.3s"]);
  await expect(nodes.last()).toHaveCSS("animation-name", "tree-branch-reveal");
  const firstEdge = page
    .locator(".tree-grow-edge .react-flow__edge-path")
    .first();
  await expect(firstEdge).toHaveAttribute("pathLength", "1");
  await expect(firstEdge).toHaveCSS("animation-name", "tree-edge-draw");
  await expect(firstEdge).toHaveCSS("animation-duration", "0.33s");
  const edgeDelays = await page
    .locator(".tree-grow-edge .react-flow__edge-path")
    .evaluateAll((items) =>
      items
        .map((item) => getComputedStyle(item).animationDelay)
        .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b)),
    );
  expect(edgeDelays).toEqual(["0.32s", "0.97s"]);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator(".tree-grow-node").first()).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(
    page.locator(".tree-grow-edge .react-flow__edge-path").first(),
  ).toHaveCSS("animation-name", "none");
});

test("mobile person card stays below the project menu and starts the memorial flight", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/tree");
  await page
    .getByRole("button", { name: /Тестов Иван Петрович/ })
    .first()
    .click();

  const card = page.getByRole("dialog", { name: "Выбранный объект" });
  await expect(card).toBeVisible();
  const dove = card.locator(".memorial-dove");
  await expect(dove).toHaveCSS("animation-name", "dove-leave");

  await page.locator('summary[aria-label="Меню проекта"]').click();
  const menu = page.locator(".nav-bottom");
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + Math.min(24, rect.height / 2);
      return document.elementFromPoint(x, y)?.closest(".nav-bottom") === node;
    }),
  ).toBe(true);
});

test("face assistant loads the versioned Human models", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const models = ["blazeface.bin", "facemesh.bin", "faceres.bin"].map((name) =>
    page.waitForResponse((response) => response.url().endsWith(`/models/human-3.3.6/${name}`)),
  );
  await page.goto("/photos");
  for (const response of await Promise.all(models)) expect(response.ok()).toBe(true);
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});
