import { expect, test } from "@playwright/test";

for (const count of [6, 60]) {
  test(`event popup stays above sticky portraits with ${count} people`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/family?projection=overview", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.family.people = Array.from({ length: count }, (_, index) => ({
        ...data.family.people[0], id: `popup-person-${index}`, birth: "1980-01-01",
        death: undefined, deceased: false, parents: [], spouses: [],
      }));
      data.family.links = [];
      data.user.personId = null;
      await route.fulfill({ response, json: data });
    });
    await page.route("**/api/family?projection=timeline&**", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.people = Array.from({ length: count }, (_, index) => ({
        id: `popup-person-${index}`, events: [], awards: [],
      }));
      await route.fulfill({ response, json: data });
    });
    await page.goto("/tree");
    await page.getByRole("button", { name: "Хронология", exact: true })
      .or(page.getByRole("switch", { name: "Древо / Хронология" })).click();
    const timeline = page.locator(".horizontal-timeline");
    const event = timeline.locator(".timeline-event.is-birth").first();
    await expect(event).toBeAttached();
    // Put the marker just to the right of the pinned portraits. Its popup
    // overlaps the next portrait, where the old equal z-index hid it.
    await event.evaluate((element) => {
      const viewport = element.closest<HTMLElement>(".horizontal-timeline")!;
      const portrait = viewport.querySelector(".timeline-person")!.getBoundingClientRect();
      const marker = element.getBoundingClientRect();
      viewport.scrollLeft += marker.x + marker.width / 2 - (portrait.right + 25);
    });
    await event.locator("summary").click();
    const popup = event.locator(".timeline-event-list");
    await expect(popup).toBeVisible();
    const hit = await popup.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const portrait = element.closest(".horizontal-timeline")!
        .querySelector(".timeline-person")!.getBoundingClientRect();
      const x = Math.min(portrait.right - 8, box.right - 8);
      const y = box.top + Math.min(box.height / 2, 32);
      return { x, y, overlaps: x > box.left, onPopup: element.contains(document.elementFromPoint(x, y)) };
    });
    expect(hit.overlaps).toBe(true);
    expect(hit.onPopup).toBe(true);
    await page.mouse.click(hit.x, hit.y);
    await expect(page.locator(".inspector-dock")).toBeVisible();
  });
}
