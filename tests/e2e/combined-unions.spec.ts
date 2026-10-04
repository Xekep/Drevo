import { expect, test } from "@playwright/test";

for (const cardVariant of ["classic", "portrait"] as const)
  test(`shared parent joins two families without a household background: ${cardVariant}`, async ({
    page,
    isMobile,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/family?projection=overview", async (route) => {
      const response = await route.fetch(),
        data = await response.json();
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
        birth: parents.length ? "1960" : "1930",
        death: undefined,
        parents,
        spouses,
      });
      data.family.people = [
        person("parent", "Иван", [], ["one", "two"]),
        { ...person("one", "Елена"), sex: "f" },
        { ...person("two", "Мария"), sex: "f" },
        person("first-a", "Алексей", ["parent", "one"]),
        person("first-b", "Пётр", ["parent", "one"]),
        person("second-a", "Сергей", ["parent", "two"]),
        person("second-b", "Николай", ["parent", "two"]),
      ];
      data.family.links = [];
      data.family.photos = [];
      data.partial = false;
      data.user.personId = null;
      data.treePreferences = {
        cardVariant,
        reverseTimeline: false,
        colorScheme: "warm",
      };
      data.reverseTimeline = false;
      await route.fulfill({ response, json: data });
    });
    await page.goto("/tree");
    await expect(page.getByTestId("rf__node-second-b")).toBeAttached();
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-growing|is-layout-settling/,
    );
    await expect(
      page.locator('.flow-person[data-person-id="parent"]'),
    ).toHaveCount(1);
    await expect(page.locator(".flow-household")).toHaveCount(0);
    if (!isMobile)
      await page
        .getByRole("button", { name: "Вписать видимую часть древа" })
        .click();
    const positions = await page
      .locator(".react-flow__node-person")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const p = new DOMMatrix(getComputedStyle(node).transform);
          return { id: node.getAttribute("data-id")!, x: p.m41, y: p.m42 };
        }),
      );
    const p = new Map(positions.map((point) => [point.id, point]));
    expect(
      (p.get("one")!.x - p.get("parent")!.x) *
        (p.get("two")!.x - p.get("parent")!.x),
    ).toBeLessThan(0);
    expect(p.get("one")!.y).toBe(p.get("two")!.y);
    expect(p.get("parent")!.y).toBe(p.get("one")!.y);
    await page.mouse.move(1, 1);
    await page.locator(".tree-canvas").screenshot({
      path: testInfo.outputPath(`combined-unions-${cardVariant}.png`),
    });
    const parent = page.getByTestId("rf__node-parent");
    await parent
      .getByRole("button", {
        name: "Свернуть ветвь",
      })
      .click();
    for (const id of ["first-a", "first-b", "second-a", "second-b"])
      await expect(page.getByTestId(`rf__node-${id}`)).toHaveCount(0);
    await expect(parent).toBeVisible();
    await parent
      .getByRole("button", {
        name: "Развернуть ветвь",
      })
      .click();
    for (const id of ["first-a", "first-b", "second-a", "second-b"])
      await expect(page.getByTestId(`rf__node-${id}`)).toBeAttached();
    await expect(
      page.locator('.flow-person[data-person-id="parent"]'),
    ).toHaveCount(1);
  });
