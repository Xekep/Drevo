import { expect, test } from "@playwright/test";

test("siblings share a floor despite unequal partner ancestry and retain full portrait dimensions", async ({
  page,
  isMobile,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const template = data.family.people[0];
    const person = (
      id: string,
      name: string,
      parents: string[] = [],
      spouses: string[] = [],
    ) => ({
      ...template,
      id,
      name,
      surname: "Тестовы",
      patronymic: "",
      birth: "",
      death: undefined,
      parents,
      spouses,
      sources: [],
      events: [],
      awards: [],
    });
    data.family.people = [
      person("parent", "Родитель"),
      person("sibling-a", "Первый ребёнок", ["parent"], ["partner"]),
      person("sibling-b", "Второй ребёнок", ["parent"]),
      person("partner", "Супруга", ["partner-parent"], ["sibling-a"]),
      person("partner-parent", "Родитель супруги", ["grandparent"]),
      person("grandparent", "Дед супруги", ["great"]),
      person("great", "Прадед супруги"),
    ];
    data.family.links = [];
    data.family.photos = [];
    data.partial = false;
    data.totals.people = data.family.people.length;
    data.user.personId = null;
    data.reverseTimeline = false;
    data.treePreferences = { reverseTimeline: false, colorScheme: "warm" };
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  await expect(page.getByTestId("rf__node-sibling-b")).toBeAttached();
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-growing|is-layout-settling/,
  );
  const coordinates = await page
    .locator(".react-flow__node-person")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const matrix = new DOMMatrix(getComputedStyle(node).transform);
        return {
          id: node.getAttribute("data-id")!,
          x: matrix.m41,
          y: matrix.m42,
          width: (node as HTMLElement).offsetWidth,
          height: (node as HTMLElement).offsetHeight,
        };
      }),
    );
  const points = new Map(coordinates.map((p) => [p.id, p]));
  expect(
    Math.abs(points.get("sibling-a")!.y - points.get("sibling-b")!.y),
  ).toBeLessThanOrEqual(60);
  expect(points.get("sibling-a")!.y).toBe(points.get("partner")!.y);
  expect(points.get("parent")!.y + 264).toBeLessThan(
    Math.min(points.get("sibling-a")!.y, points.get("sibling-b")!.y),
  );
  expect(
    Math.abs(points.get("parent")!.y - points.get("partner-parent")!.y),
  ).toBeLessThanOrEqual(60);
  for (const card of coordinates) {
    expect(card.width).toBe(220);
    expect(card.height).toBe(264);
    for (const other of coordinates) {
      if (card.id === other.id) continue;
      const overlap =
        card.x < other.x + other.width &&
        card.x + card.width > other.x &&
        card.y < other.y + other.height &&
        card.y + card.height > other.y;
      expect(overlap, `${card.id} overlaps ${other.id}`).toBe(false);
    }
  }
  // Mobile fits the tree automatically and does not display desktop controls.
  if (!isMobile)
    await page
      .getByRole("button", { name: "Вписать видимую часть древа" })
      .click();
  await page
    .locator(".tree-canvas")
    .screenshot({ path: testInfo.outputPath("generation-alignment.png") });
});
