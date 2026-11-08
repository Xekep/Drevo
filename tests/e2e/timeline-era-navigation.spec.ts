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
  if (info.project.name === "mobile") await soviet.tap();
  else await soviet.click();
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1957");
  await expect(soviet).toHaveAttribute("aria-current", "date");
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
  await page.getByRole("button", { name: "Сейчас", exact: true }).click();
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText(String(new Date().getFullYear()));

  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "Развернуть на весь экран", exact: true }).click();
    await expect(navigator).toBeVisible();
    await soviet.tap();
    await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1957");
  }
});
