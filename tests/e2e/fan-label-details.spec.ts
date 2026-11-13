import { expect, test } from "@playwright/test";
import { familyViewAction } from "./tree-toolbar-actions";

test("outer fan rings retain names and years within their sectors", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/family?projection=overview*", async route => {
    const response = await route.fetch(), data = await response.json();
    const base = data.family.people[0];
    const people = Array.from({ length: 31 }, (_, index) => ({ ...base,
      id: `fan-details-${index}`, surname: index % 2 ? "Константинопольский" : "Сковородникова",
      name: "Александр", patronymic: "Владимирович", sex: index % 2 ? "m" : "f",
      birth: "1870", death: "1940", generation: 1, column: index, photo: "", spouses: [],
      parents: index < 15 ? [`fan-details-${2 * index + 1}`, `fan-details-${2 * index + 2}`] : [],
    }));
    data.family = { ...data.family, people, photos: [], links: [], unions: [], documents: [] };
    data.totals = { ...data.totals, people: people.length, photos: 0 };
    data.partial = false;
    delete data.fragment;
    data.user.personId = people[0].id;
    data.treePreferences = { ...data.treePreferences, fragmentThreshold: 0, animateOnLoad: false,
      fanShowNames: true, fanShowYears: true, fanShowPortraits: false };
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-grow|is-layout-settling/);
  await page.getByTestId("rf__node-fan-details-0").locator(".flow-person-content").click();
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "Свернуть панель", exact: true }).click();
  await familyViewAction(page, "Веер");
  const fan = page.locator(".fan-chart-svg");
  await expect(fan).toBeVisible();
  await expect(canvas).not.toHaveClass(/is-fan-revealing/);
  for (const generation of [2, 3, 4]) {
    const sectors = fan.locator(`[data-fan-generation="${generation}"]`);
    await expect(sectors).toHaveCount(2 ** generation);
    const lines = sectors.first().locator(".fan-sector-label tspan");
    await expect(lines).toHaveCount(4);
    await expect(lines.nth(1)).toHaveText("Александр");
    const patronymic = await lines.nth(2).textContent();
    expect(patronymic).toMatch(/^Владим/);
    expect(patronymic === "Владимирович" || (patronymic!.endsWith("…") &&
      "Владимирович".startsWith(patronymic!.slice(0, -1)))).toBe(true);
    await expect(lines.last()).toHaveText("1870 — 1940");
  }
  // Check actual glyph boxes against the SVG sector, independently of label budgets.
  const overflow = await fan.evaluate(svg => {
    const failures: string[] = [];
    for (const sector of svg.querySelectorAll<SVGGElement>('[data-fan-generation="2"], [data-fan-generation="3"], [data-fan-generation="4"]')) {
      const path = sector.querySelector("path")!;
      for (const span of sector.querySelectorAll<SVGTSpanElement>(".fan-sector-label tspan")) {
        const box = span.getBBox();
        const matrix = path.getCTM()!.inverse().multiply(span.getCTM()!);
        for (const [x, y] of [[box.x, box.y], [box.x + box.width, box.y],
          [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]) {
          if (!path.isPointInFill(new DOMPoint(x, y).matrixTransform(matrix)))
            failures.push(`${sector.dataset.fanSlot}: ${span.textContent}`);
        }
      }
    }
    return failures;
  });
  expect(overflow).toEqual([]);
  await page.screenshot({ path: info.outputPath("fan-ring-details.png") });
});
