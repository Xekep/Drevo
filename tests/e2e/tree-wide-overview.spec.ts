import { expect, test } from "@playwright/test";

test("full overview contains a wide sibling generation, including after mobile resize", async ({ page, isMobile }) => {
  await page.route("**/api/family?projection=overview", async route => {
    const response = await route.fetch(), data = await response.json();
    const base = data.family.people[0];
    data.family.people = [
      { ...base, id: "wide-root", name: "Родитель", birth: "1900", parents: [], spouses: [], photo: undefined },
      ...Array.from({ length: 48 }, (_, i) => ({ ...base, id: `wide-${i}`, name: `Потомок ${i}`,
        birth: "1930", parents: ["wide-root"], spouses: [], photo: undefined })),
    ];
    data.family.links = [];
    data.family.photos = [];
    data.family.unions = [];
    data.user.personId = null;
    data.treePreferences = { ...data.treePreferences, animateOnLoad: false, reverseTimeline: false };
    data.partial = false;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-grow|is-layout-settling/);
  const fits = () => page.evaluate(() => {
    const rect = document.querySelector(".tree-canvas")!.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.flow-person[data-person-id^="wide-"]')];
    if (cards.length !== 49) return false;
    return cards.every(card => {
      const box = card.getBoundingClientRect();
      return box.left >= rect.left - 1 && box.right <= rect.right + 1 &&
        box.top >= rect.top - 1 && box.bottom <= rect.bottom + 1;
    });
  });
  await page.getByRole("button", { name: "Вписать видимую часть древа", exact: true }).click();
  await expect.poll(fits).toBe(true);
  if (isMobile) {
    const zoom = await page.locator(".react-flow__viewport").evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
    expect(zoom).toBeLessThan(0.05);
    await page.setViewportSize({ width: 320, height: 740 });
    await page.getByRole("button", { name: "Вписать видимую часть древа", exact: true }).click();
    await expect.poll(fits).toBe(true);
  }
});
