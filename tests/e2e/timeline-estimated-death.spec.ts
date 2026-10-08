import { expect, test } from "@playwright/test";
import type { Family } from "../../src/domain/types";

test("chronology labels death estimates, removes them after that year and distinguishes the next twenty years", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = await (await page.request.get("/api/family")).json();
  const family = structuredClone(snapshot.family) as Family;
  for (const person of family.people) {
    Object.assign(person, { parents: [], spouses: [], sources: [], events: [], awards: [],
      birth: "1900", death: undefined, deceased: false, deathPlace: "", generation: 1 });
    if (person.id === "e2e-memorial-person") Object.assign(person, { sex: "m", death: "1960" });
    if (person.id === "e2e-spouse") Object.assign(person, { sex: "f", death: "1980" });
    if (person.id === "e2e-child") Object.assign(person, { sex: "m", birth: "1850", deceased: true });
    if (person.id === "e2e-sibling") Object.assign(person, { sex: "f", birth: "1850", deceased: true });
    if (person.id === "e2e-grandchild") Object.assign(person, { birth: "1990" });
    if (person.id === "e2e-sibling-child") Object.assign(person, { sex: "u", deceased: true });
  }
  const archiveWrites: string[] = [];
  await page.route("**/api/family**", async (route) => {
    if (route.request().method() !== "GET") {
      archiveWrites.push(route.request().url());
      return route.continue();
    }
    const response = await route.fetch();
    const data = await response.json();
    const url = new URL(route.request().url());
    if (url.searchParams.get("projection") === "page") {
      if (url.searchParams.get("collection") !== "people") return route.fulfill({ response, json: data });
      return route.fulfill({ response, json: { ...data, items: family.people, total: family.people.length } });
    }
    if (!data.family) return route.fulfill({ response, json: data });
    await route.fulfill({ response, json: { ...data, family } });
  });
  await page.goto("/tree");
  await expect(page.locator(".react-flow__node").first()).toBeAttached();
  await page.getByRole("button", { name: "Хронология", exact: true })
    .or(page.getByRole("switch", { name: "Древо / Хронология" })).click();
  const timeline = page.locator(".horizontal-timeline");
  const marker = page.getByLabel("Год в центре хронологии");
  const goToYear = async (year: number) => {
    await timeline.evaluate((element, year) => {
      const current = Number(document.querySelector(".timeline-center-marker output")?.textContent);
      element.scrollLeft += (year - current) * 12;
    }, year);
    await expect(marker).toHaveText(String(year));
  };
  await expect(marker).toHaveText("1850");
  await goToYear(1920);
  const male = timeline.locator('[data-person-id="e2e-child"]');
  await expect(male.locator(".timeline-life")).toHaveClass(/is-estimated/);
  await expect(male.locator(".timeline-person small")).toHaveText("≈ Смерть");
  await expect(male.locator(".timeline-person small")).toHaveAttribute("title", "Предположительный год смерти");
  const death = male.locator(".timeline-event.is-estimated");
  await male.getByLabel("1920: Предположительная смерть", { exact: true }).click();
  await expect(death.locator(".timeline-event-list")).toContainText("60 лет");
  await expect(death.locator(".timeline-event-list")).toContainText("расчётная отметка");
  await expect(page.locator(".timeline-center-marker")).toHaveCSS("border-left-color", "rgba(0, 0, 0, 0)");
  const popup = death.locator(".timeline-event-list");
  const popupBox = await popup.boundingBox();
  expect(popupBox?.x).toBeGreaterThanOrEqual(0);
  expect((popupBox?.x || 0) + (popupBox?.width || 0)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await timeline.screenshot({ path: testInfo.outputPath("estimated-death.png") });
  await goToYear(1921);
  await expect(male).toHaveCount(0);
  await goToYear(1940);
  await expect(timeline.locator('[data-person-id="e2e-sibling"] .timeline-person small'))
    .toHaveText("≈ Смерть");
  await goToYear(1941);
  await expect(timeline.locator('[data-person-id="e2e-sibling"]')).toHaveCount(0);
  const currentYear = new Date().getFullYear();
  await goToYear(currentYear);
  await expect(timeline.locator('[data-person-id="e2e-sibling-child"]')).toHaveCount(0);
  await expect(page.locator(".timeline-center-marker")).not.toHaveClass(/is-future/);
  await timeline.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect(marker).toHaveText(String(currentYear + 20));
  await expect(page.locator(".timeline-center-marker")).toHaveClass(/is-future/);
  await expect(page.locator(".timeline-center-marker > span")).toContainText("Будущее");
  await expect(timeline.locator(".timeline-future-range")).toContainText(`${currentYear + 1}–${currentYear + 20}`);
  await expect(page.getByRole("button", { name: "На 10 лет вперёд" })).toBeDisabled();
  await timeline.screenshot({ path: testInfo.outputPath("timeline-future.png") });
  expect(archiveWrites).toEqual([]);
});
