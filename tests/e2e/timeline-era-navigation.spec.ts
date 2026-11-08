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
  expect(bounds.height).toBeLessThanOrEqual(info.project.name === "desktop" ? 34 : 46);
  for (const button of await buttons.all()) {
    await expect(button).toBeInViewport({ ratio: 1 });
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
  for (const button of await buttons.all()) {
    await expect(button).toBeInViewport({ ratio: 1 });
  }

  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "Развернуть на весь экран", exact: true }).click();
    await expect(navigator).toBeVisible();
    await soviet.tap();
    await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1957");
  }
});
