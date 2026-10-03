import { test, expect } from "@playwright/test";
import type { Person } from "../../src/domain/types";

test("folding descendants hides detached in-laws but keeps partners connected through another branch", async ({
  page,
  isMobile,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.assign(window, { foldLayoutRequests: [] });
    Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
      apply(target, thisArg, args) {
        if (Array.isArray(args[0]?.people))
          (
            window as typeof window & { foldLayoutRequests: string[][] }
          ).foldLayoutRequests.push(
            args[0].people.map((person: { id: string }) => person.id),
          );
        return Reflect.apply(target, thisArg, args);
      },
    });
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const child = data.family.people.find(
      (p: Person) => p.id === "e2e-grandchild",
    )!;
    child.spouses = ["fold-detached", "fold-connected"];
    data.family.people.push(
      {
        ...child,
        id: "fold-detached",
        name: "Отсоединяемый",
        parents: ["fold-in-law"],
        spouses: [child.id],
      },
      {
        ...child,
        id: "fold-in-law",
        name: "Родитель супруга",
        birth: "1960-01-01",
        parents: [],
        spouses: [],
      },
      {
        ...child,
        id: "fold-connected",
        name: "Связанный",
        parents: ["e2e-memorial-person"],
        spouses: [child.id],
      },
    );
    data.user.personId = null;
    data.partial = false;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  const card = (id: string) =>
    page.locator(`.flow-person[data-person-id="${id}"]`);
  const boundary = card("e2e-child").first();
  const overview = async () => {
    await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
    if (isMobile) {
      const bounds = (await canvas.boundingBox())!;
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, 800);
      await page.keyboard.up("Control");
    } else {
      await page
        .getByRole("button", { name: "Вписать видимую часть дерева" })
        .click();
    }
  };
  for (const id of [
    "e2e-grandchild",
    "fold-detached",
    "fold-in-law",
    "fold-connected",
  ])
    await expect(card(id).first()).toBeVisible();

  await boundary
    .getByRole("button", { name: /Свернуть (потомков|ветвь)/ })
    .click();
  await overview();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as typeof window & { foldLayoutRequests: string[][] }
        ).foldLayoutRequests
          .at(-1)
          ?.slice()
          .sort(),
      ),
    )
    .toEqual(
      [
        "e2e-memorial-person",
        "e2e-child",
        "e2e-spouse",
        "e2e-sibling",
        "e2e-sibling-child",
        "fold-connected",
      ].sort(),
    );
  await testInfo.attach("fold-state.json", {
    contentType: "application/json",
    body: JSON.stringify(
      await page.evaluate(() => ({
        requests: (window as typeof window & { foldLayoutRequests: string[][] })
          .foldLayoutRequests,
        viewport: document.querySelector<HTMLElement>(".react-flow__viewport")
          ?.style.transform,
        mounted: [...document.querySelectorAll(".flow-person")].map((node) =>
          node.getAttribute("data-person-id"),
        ),
      })),
    ),
  });
  for (const id of ["e2e-grandchild", "fold-detached", "fold-in-law"])
    await expect(card(id)).toHaveCount(0);
  for (const id of ["e2e-child", "e2e-spouse", "fold-connected"])
    await expect(card(id).first()).toBeVisible();
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  await page.screenshot({ path: testInfo.outputPath("folded-branch.png") });

  await boundary
    .getByRole("button", { name: /Развернуть (потомков|ветвь)/ })
    .click();
  await overview();
  for (const id of [
    "e2e-grandchild",
    "fold-detached",
    "fold-in-law",
    "fold-connected",
  ])
    await expect(card(id).first()).toBeVisible();
});

test("nested folds disappear with their parent and stay folded when the parent reopens", async ({
  page,
}) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  const card = (id: string) =>
    page.locator(`.flow-person[data-person-id="${id}"]`);
  const parent = card("e2e-memorial-person").first();
  const child = card("e2e-child").first();
  await child
    .getByRole("button", { name: /Свернуть (потомков|ветвь)/ })
    .click();
  await expect(card("e2e-grandchild")).toHaveCount(0);
  await parent
    .getByRole("button", { name: /Свернуть (потомков|ветвь)/ })
    .click();
  await expect(card("e2e-child")).toHaveCount(0);
  await expect(card("e2e-spouse")).toHaveCount(0);
  await expect(parent).toBeVisible();
  await parent
    .getByRole("button", { name: /Развернуть (потомков|ветвь)/ })
    .click();
  await expect(child).toBeVisible();
  await expect(card("e2e-spouse").first()).toBeVisible();
  await expect(card("e2e-grandchild")).toHaveCount(0);
  await child
    .getByRole("button", { name: /Развернуть (потомков|ветвь)/ })
    .click();
  await expect(card("e2e-grandchild").first()).toBeVisible();
});
