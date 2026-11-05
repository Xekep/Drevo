import { expect, test, type Page } from "@playwright/test";
import type { PersonAward } from "../../src/domain/types.ts";

const fixtureAwards: PersonAward[] = ["1985", "1945", undefined, "1941", "1955", "1945", undefined, "1960"].map((year, i) => ({
  id: `layout-award-${i}`, name: `Награда ${i + 1}`, year,
  awardDefinitionId: i % 2 ? "ussr-medal-veteran-labour" : "ussr-medal-for-courage",
  source: { title: `Источник награды ${i + 1}` },
}));

async function openAwards(page: Page, awards: PersonAward[]) {
  const response = await page.request.get("/api/family");
  const snapshot = await response.json();
  snapshot.family.people.find((person: { id: string }) => person.id === "e2e-child").awards = awards;
  await page.route("**/api/family?projection=overview", route =>
    route.fulfill({ response, json: { ...snapshot, partial: false } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/people/e2e-child");
  const stack = page.locator(".inspector-dock .award-stack");
  await expect(stack.locator(".award-medal-button")).toHaveCount(awards.length);
  return stack;
}

test("eight medals fit the person card and follow years without changing the editor order", async ({ page, isMobile }, info) => {
  const stack = await openAwards(page, fixtureAwards);
  const buttons = stack.locator(".award-medal-button");
  const names = () => buttons.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")!.split(",")[0]));
  await expect.poll(names).toEqual([4, 2, 6, 5, 8, 1, 3, 7].map(i => `Награда ${i}`));
  for (const width of isMobile ? [320, 390] : [1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => stack.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const rows = await stack.locator(".award-stack-item").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).offsetTop));
    expect(new Set(rows).size).toBe(1);
    await buttons.first().focus();
    if (await buttons.first().getAttribute("aria-pressed") !== "true") await buttons.first().click();
    const details = page.locator(".award-focus-card");
    await expect(details).toContainText("Награда 4");
    await expect(details).toContainText("1941");
    await expect(details).toContainText("Источник награды 4");
    await expect.poll(() => stack.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await buttons.last().focus();
    await expect(details).toContainText("Награда 7");
    await expect.poll(() => stack.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`eight-medals-${width}.png`) });
  }
  await page.locator(".inspector-person-actions .person-edit-button").click();
  const editorAwards = page.locator(".award-editor-strip .award-editor-chip");
  await expect(editorAwards).toHaveCount(fixtureAwards.length);
  expect(await editorAwards.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))))
    .toEqual(fixtureAwards.map(award => `Редактировать: ${award.name}`));
});

test("a ninth medal scrolls horizontally and remains keyboard accessible", async ({ page, isMobile }) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1024, height: 900 });
  const stack = await openAwards(page, [...fixtureAwards, { ...fixtureAwards[0], id: "ninth", name: "Девятая награда", year: "1939" }]);
  await expect.poll(() => stack.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  const buttons = stack.locator(".award-medal-button");
  await expect(buttons.first()).toHaveAttribute("aria-label", /Девятая награда, 1939/);
  await stack.evaluate(element => element.scrollTo({ left: element.scrollWidth }));
  await expect.poll(() => stack.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await buttons.last().focus();
  await buttons.last().press("Enter");
  await expect(page.locator(".award-focus-card")).toContainText("Награда 7");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
