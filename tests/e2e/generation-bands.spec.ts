import { expect, test } from "@playwright/test";

test("rendered families share generation floors with bounded soft alignment", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
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
    });
    data.family.people = [
      person("root", "Иван", [], ["root-spouse"]),
      person("root-spouse", "Мария", [], ["root"]),
      person("leaf", "Алексей", ["root", "root-spouse"]),
      person("branch", "Пётр", ["root", "root-spouse"], ["spouse"]),
      person("spouse", "Елена", [], ["branch"]),
      person("other", "Ольга", ["root", "root-spouse"]),
      person("grand-a", "Анна", ["branch", "spouse"]),
      person("grand-b", "Сергей", ["branch", "spouse"]),
      person("grand-c", "Вера", ["branch", "spouse"]),
      person("grand-d", "Николай", ["other"]),
    ];
    data.family.links = [];
    data.family.photos = [];
    data.partial = false;
    data.user.personId = null;
    data.treePreferences = {
      cardVariant: "classic",
      reverseTimeline: false,
      colorScheme: "warm",
    };
    data.reverseTimeline = false;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  await expect(page.getByTestId("rf__node-grand-d")).toBeAttached();
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
        };
      }),
    );
  const points = new Map(coordinates.map((p) => [p.id, p]));
  const middle = ["leaf", "branch", "spouse", "other"].map(
    (id) => points.get(id)!.y,
  );
  expect(Math.max(...middle) - Math.min(...middle)).toBeGreaterThan(0);
  expect(Math.max(...middle) - Math.min(...middle)).toBeLessThanOrEqual(60);
  expect(points.get("branch")!.y).toBe(points.get("spouse")!.y);
  expect(points.get("root")!.y + 150).toBeLessThanOrEqual(Math.min(...middle));
  expect(Math.max(...middle) + 150).toBeLessThanOrEqual(
    points.get("grand-a")!.y,
  );
  await page
    .getByRole("button", { name: "Вписать видимую часть дерева" })
    .click();
  await expect(page.getByTestId("rf__node-grand-d")).toBeInViewport({
    ratio: 1,
  });
  await page
    .locator(".tree-canvas")
    .screenshot({ path: testInfo.outputPath("generation-bands.png") });
});
