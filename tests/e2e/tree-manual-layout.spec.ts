import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const position = (node: Locator) =>
  node.evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f };
  });

async function relativePdfPosition(page: Page, path: string) {
  await page
    .locator(".react-flow__pane")
    .click({ button: "right", position: { x: 40, y: 350 } });
  await page.getByRole("menuitem", { name: "Экспорт древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Экспорт древа" });
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  await (await pending).saveAs(path);
  const pdf = await getDocument({ data: new Uint8Array(await readFile(path)) })
    .promise;
  try {
    const items = (await (await pdf.getPage(1)).getTextContent()).items.flatMap(
      (item) => ("str" in item ? [item] : []),
    );
    const child = items.find((item) => /(?:^|\s)Пётр(?:\s|$)/u.test(item.str));
    const parent = items.find((item) => /(?:^|\s)Иван(?:\s|$)/u.test(item.str));
    expect(child).toBeDefined();
    expect(parent).toBeDefined();
    return child!.transform[4] - parent!.transform[4];
  } finally {
    await pdf.loadingTask.destroy();
    await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  }
}

test("visible-tree PDF retains manual placement after finishing the mode", async ({
  page,
  isMobile,
}, info) => {
  test.skip(isMobile, "Manual print composition is desktop-only");
  await page.goto("/tree");
  const trigger = page.getByRole("button", {
    name: "Ручная расстановка карточек",
    exact: true,
  });
  await expect(trigger).toBeEnabled();
  const before = await relativePdfPosition(page, info.outputPath("before.pdf"));
  await trigger.click();
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page
    .getByRole("region", { name: "Ручная расстановка", exact: true })
    .getByRole("button", { name: "Готово", exact: true })
    .click();
  const after = await relativePdfPosition(page, info.outputPath("after.pdf"));
  expect(after - before).toBeGreaterThan(1);
});

test("manual placement moves spouses together, keeps the camera still and never writes family data", async ({
  page,
  isMobile,
}, info) => {
  await page.goto("/tree");
  const trigger = page.getByRole("button", {
    name: "Ручная расстановка карточек",
    exact: true,
  });
  if (isMobile) {
    await expect(trigger).toHaveCount(0);
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(trigger).toHaveCount(0);
    return;
  }
  await trigger.click();
  const canvas = page.locator(".tree-canvas"),
    tools = page.getByRole("region", {
      name: "Ручная расстановка",
      exact: true,
    });
  await expect(canvas).toHaveClass(/is-manual-layout/);
  let writes = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/family(?:\/changes)?$/.test(new URL(request.url()).pathname)
    )
      writes++;
  });
  const child = page.getByTestId("rf__node-e2e-child"),
    spouse = page.getByTestId("rf__node-e2e-spouse");
  const beforeChild = await position(child),
    beforeSpouse = await position(spouse);
  const viewport = page.locator(".react-flow__viewport"),
    camera = await viewport.getAttribute("style");
  const card = child.locator(".flow-person-content"),
    box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 30,
    box.y + box.height / 2 + 50,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await position(child)).x)
    .not.toBe(beforeChild.x);
  const afterChild = await position(child),
    afterSpouse = await position(spouse);
  expect(afterChild.y).toBe(beforeChild.y);
  expect(afterSpouse.y).toBe(beforeSpouse.y);
  expect(afterChild.x - beforeChild.x).toBeCloseTo(
    afterSpouse.x - beforeSpouse.x,
    2,
  );
  await expect(viewport).toHaveAttribute("style", camera!);
  await expect(page.locator(".inspector-dock")).toHaveCount(0);
  await tools.getByRole("button", { name: "Отменить сдвиг карточки" }).click();
  await expect.poll(() => position(child)).toEqual(beforeChild);
  await expect.poll(() => position(spouse)).toEqual(beforeSpouse);
  await card.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect
    .poll(async () => (await position(child)).x)
    .toBeCloseTo(beforeChild.x + 5, 3);
  await tools.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(canvas).not.toHaveClass(/is-manual-layout/);
  await expect
    .poll(async () => (await position(child)).x)
    .toBeCloseTo(beforeChild.x + 5, 3);
  await trigger.click();
  await tools.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect.poll(() => position(child)).toEqual(beforeChild);
  const again = (await card.boundingBox())!;
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    again.x + again.width / 2 + 25,
    again.y + again.height / 2,
    { steps: 5 },
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(canvas).not.toHaveClass(/is-manual-layout/);
  await expect.poll(() => position(child)).toEqual(beforeChild);
  await expect(page.locator(".inspector-dock")).toHaveCount(0);
  expect(writes).toBe(0);
  await trigger.click();
  await page.screenshot({ path: info.outputPath("manual-placement.png") });
});
