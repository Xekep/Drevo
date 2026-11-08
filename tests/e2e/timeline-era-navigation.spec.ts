import { expect, test } from "@playwright/test";

test("all eras stay reachable in the compact navigator while the timeline scrolls", async ({ page }, info) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.family.people.push({
      ...data.family.people[0],
      id: "era-navigation-ancestor",
      birth: "1500-01-01",
      death: "1580-01-01",
      parents: [],
      spouses: [],
    });
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/family?projection=timeline&**", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.people.push({ id: "era-navigation-ancestor", events: [], awards: [] });
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Хронология", exact: true })
    .or(page.getByRole("switch", { name: "Древо / Хронология" })).click();
  const navigator = page.getByRole("navigation", { name: "Переход к исторической эпохе" });
  const buttons = navigator.getByRole("button");
  await expect(buttons).toHaveCount(6);
  const bounds = (await navigator.boundingBox())!;
  expect(bounds.height).toBeLessThanOrEqual(56);
  await expect(page.locator(".timeline-toolbar")).toHaveCount(1);
  await expect(page.locator(".timeline-axis")).toHaveCount(0);
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText(String(new Date().getFullYear()));
  const yearStatus = page.getByRole("button", { name: "К текущему году", exact: true });
  await expect(yearStatus).toHaveText("Сейчас");
  const position = navigator.locator(".timeline-era-position");
  await expect(position).toHaveText(String(new Date().getFullYear()));
  await expect(position).toBeInViewport();
  await expect(page.locator(".timeline-year-counts")).toBeVisible();
  await page.locator(".timeline-toolbar").screenshot({ path: info.outputPath("timeline-current-year.png") });
  for (const button of await buttons.all()) {
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
  }

  if (info.project.name === "desktop") {
    const first = buttons.first();
    const before = await first.boundingBox();
    await first.hover();
    await expect.poll(() => first.evaluate((element) => getComputedStyle(element, "::after").transform))
      .toBe("matrix(1, 0, 0, 1.6, 0, 0)");
    expect(await first.boundingBox()).toEqual(before);
  }

  const soviet = navigator.getByRole("button", { name: "Советский Союз, 1922–1991", exact: true });
  if (info.project.name === "desktop") {
    await soviet.hover();
    const preview = page.getByRole("tooltip");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("центр 1957");
    await page.screenshot({ path: info.outputPath("timeline-range-preview.png") });
    // The hint must describe the actual visible dates, excluding the sticky portraits.
    const halfYears = await page.locator(".horizontal-timeline").evaluate((element) =>
      (element.clientWidth - parseFloat(getComputedStyle(element).getPropertyValue("--timeline-person-width"))) / 24);
    await expect(preview.locator("strong")).toHaveText(
      `${Math.max(1490, Math.round(1957 - halfYears))}–${Math.min(new Date().getFullYear() + 20, Math.round(1957 + halfYears))}`,
    );
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await soviet.focus();
    await expect(preview).toBeVisible();
  }
  if (info.project.name === "mobile") await soviet.tap();
  else await soviet.click();
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1957");
  await expect(soviet).toHaveAttribute("aria-current", "date");
  await expect(yearStatus).toHaveText("Прошлое");
  await expect(position).toHaveText("1957");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  expect(await navigator.boundingBox()).toEqual(bounds);

  // The last era and early history are accessible without scrolling the strip.
  await buttons.last().click();
  await expect(buttons.last()).toHaveAttribute("aria-current", "date");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await buttons.first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1519");
  await expect(buttons.first()).toHaveAttribute("aria-current", "date");
  await expect.poll(() => buttons.first().evaluate((element) => getComputedStyle(element, "::after").transform))
    .toBe("none");
  for (const button of await buttons.all()) {
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
  }
  await yearStatus.click();
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText(String(new Date().getFullYear()));
  await expect(yearStatus).toHaveText("Сейчас");
  await expect(position).toBeInViewport();
  await page.getByRole("button", { name: "На 10 лет вперёд", exact: true }).click();
  await expect(yearStatus).toHaveText("Будущее");
  await yearStatus.click();
  await expect(yearStatus).toHaveText("Сейчас");

  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "Развернуть на весь экран", exact: true }).click();
    await expect(navigator).toBeVisible();
    await soviet.tap();
    await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1957");
  }
});
