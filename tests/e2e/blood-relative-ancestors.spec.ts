import { expect, test } from "@playwright/test";
import type { Family, Person } from "../../src/domain/types.ts";

test("blood view includes an unmarried co-parent but leaves their ancestors and lateral relatives hidden", async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = await (await page.request.get("/api/family")).json();
  const family = structuredClone(snapshot.family) as Family;
  const template = family.people.find((p) => p.id === "e2e-sibling")!;
  const person = (id: string, parents: string[] = [], spouses: string[] = []): Person => ({
    ...template, id, name: id, parents, spouses, awards: [], sources: [],
  });
  family.people.find((p) => p.id === "e2e-sibling-child")!.parents.push("co-parent");
  family.people.push(
    person("co-parent", ["co-grandparent"], ["co-other"]),
    { ...person("co-grandparent"), generation: 1, birth: "1935" },
    person("co-sibling", ["co-grandparent"]),
    { ...person("co-other-child", ["co-parent"]), generation: 3, birth: "1995" },
    person("co-other", [], ["co-parent"]),
  );
  await page.route("**/api/family**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    const url = new URL(route.request().url());
    if (url.searchParams.get("projection") === "page") {
      if (url.searchParams.get("collection") !== "people")
        return route.fulfill({ response, json: data });
      return route.fulfill({ response, json: { ...data, items: family.people, total: family.people.length } });
    }
    if (!data.family) return route.fulfill({ response, json: data });
    await route.fulfill({ response, json: {
      ...data, family,
      ...(data.totals ? { totals: { ...data.totals, people: family.people.length } } : {}),
    } });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content")
    .evaluate((card) => (card as HTMLElement).click());
  const dock = page.getByRole("complementary", { name: "Выбранный объект" });
  if (isMobile && await dock.isVisible()) await dock.getByRole("button", { name: "Свернуть панель" }).click();
  if (isMobile) await page.getByLabel("Область просмотра", { exact: true }).click();
  await page.getByRole("button", { name: "Кровные", exact: true }).click();
  if (isMobile) await page.getByLabel("Область просмотра", { exact: true }).click();
  await expect(page.locator(".tree-family-count")).toHaveText("7 из 11");
  for (const id of ["co-parent"])
    await expect(page.getByTestId(`rf__node-${id}`)).toBeAttached();
  for (const id of ["co-grandparent", "co-sibling", "co-other-child", "co-other"])
    await expect(page.getByTestId(`rf__node-${id}`)).toHaveCount(0);
  await page.getByRole("button", { name: "Всё древо", exact: true }).click();
  await expect(page.locator(".tree-family-count")).toHaveCount(0);
  await expect(page.getByTestId("rf__node-co-other")).toBeAttached();
});
