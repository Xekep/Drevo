import { test, expect } from "@playwright/test";
import { familyViewAction } from "./tree-toolbar-actions";

test("close family keeps compact controls and recursive collapse independently of automatic fragments", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const template = data.family.people[0];
    data.family.people = Array.from({ length: 100 }, (_, index) => ({
      ...template,
      id: `scope-${index}`,
      name: `Человек ${index}`,
      surname: "Проверка",
      patronymic: "",
      birth: "1900",
      photo: undefined,
      parents: index > 0 && index < 5 ? [`scope-${index - 1}`] : [],
      spouses: [],
      generation: index + 1,
    }));
    data.family.links = [];
    data.family.unions = [];
    data.family.photos = [];
    data.partial = false;
    data.totals.people = 100;
    data.user.personId = "scope-0";
    data.treePreferences = {
      ...data.treePreferences,
      fragmentThreshold: 100,
      animateOnLoad: false,
    };
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  const status = page.getByRole("region", { name: "Фрагмент большого древа" });
  await expect(status).toBeVisible();
  await expect(page.locator('.tree-family-name[title^="Близкие:"]')).toHaveCount(0);
  await page
    .getByRole("combobox", { name: /Найти человека/ })
    .fill("Человек 0");
  await page
    .getByRole("option", { name: /^Проверка Человек 0(?:\s|$)/ })
    .click();
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "Свернуть панель" }).click();
  await familyViewAction(page, "Близкие");
  await page.getByRole("button", { name: /Закрыть панель/ }).click();
  await expect(status).toHaveCount(0);
  await expect(page.locator('.tree-family-name[title^="Близкие:"]')).toHaveCount(1);
  await expect(canvas).toHaveAttribute("data-layout-people", "2");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-layout-settling/);
  const card = (index: number) =>
    page.locator(`.flow-person[data-person-id="scope-${index}"]`);
  const first = card(1).getByRole("button", {
    name: /^Показать ещё 1 родственников:/,
  });
  await expect(first).toHaveText("Ещё 1");
  await expect(first).not.toHaveClass(/is-fragment-continuation/);
  const style = await first.evaluate((button) => {
    const css = getComputedStyle(button);
    return {
      font: css.fontSize,
      radius: css.borderRadius,
      padding: css.padding,
      right: css.right,
    };
  });
  expect(style.font).toBe(info.project.name === "mobile" ? "14px" : "12px");
  expect(style.radius).toBe("7px");
  expect(style.right).toBe("10px");
  await first.click();
  await expect(canvas).toHaveAttribute("data-layout-people", "3");
  const second = card(2).getByRole("button", {
    name: /^Показать ещё 1 родственников:/,
  });
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-layout-settling/);
  // Branch expansion preserves the clicked card's screen position. A further
  // generation can be outside a short desktop viewport and be virtualized.
  await page.getByRole("button", { name: "Вписать видимую часть древа" }).click();
  await expect(second).toBeInViewport();
  await second.click();
  await expect(canvas).toHaveAttribute("data-layout-people", "4");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-layout-settling/);
  await card(1)
    .getByRole("button", { name: /^Свернуть раскрытую ветвь:/ })
    .click();
  await expect(canvas).toHaveAttribute("data-layout-people", "2");
  await expect(card(0)).toHaveAttribute("data-anchor", "true");
  await expect(card(2)).toHaveCount(0);
  await expect(card(3)).toHaveCount(0);
  await expect(first).toHaveText("Ещё 1");
  await page.screenshot({ path: info.outputPath("close-family-restored.png") });
  await familyViewAction(page, "Всё древо");
  await expect(status).toBeVisible();
  await expect(page.locator('.tree-family-name[title^="Близкие:"]')).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-layout-people", "4");
  const fragmentButton = card(3).getByRole("button", {
    name: /^Ещё 1 родственник:/,
  });
  await expect(fragmentButton).toHaveText("Ещё 1");
  const fragmentStyle = await fragmentButton.evaluate((button) => {
    const css = getComputedStyle(button);
    return {
      font: css.fontSize,
      radius: css.borderRadius,
      padding: css.padding,
      right: css.right,
    };
  });
  expect(fragmentStyle).toEqual(style);
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-layout-settling/);
  await page.getByRole("button", { name: "Вписать видимую часть древа" }).click();
  await expect(fragmentButton).toBeInViewport();
  await fragmentButton.click();
  await expect(canvas).toHaveAttribute("data-layout-people", "5");
  await expect(
    page.getByRole("dialog", { name: "Продолжение ветвей" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("fragment-compact-control.png"),
  });
  // Closing the initial profile cleared selection. Locate the anchor through
  // search: its card may now be behind the fixed toolbar after fitting.
  const search = page.getByRole("combobox", { name: /Найти человека/ });
  await search.fill("");
  await search.fill("Человек 0");
  await page.getByRole("option", { name: /^Проверка Человек 0(?:\s|$)/ }).click();
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "Свернуть панель" }).click();
  await familyViewAction(page, "Близкие");
  await expect(canvas).toHaveAttribute("data-layout-people", "2");
});

for (const [count, label] of [
  [1, "родственник"],
  [2, "родственника"],
  [5, "родственников"],
  [21, "родственник"],
] as const) {
  test(`fragment continuation under a person shows ${count} ${label} and opens their relatives`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/family?projection=overview", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      const template = data.family.people[0];
      data.family.people = Array.from({ length: 100 }, (_, index) => ({
        ...template,
        id: `continuation-${index}`,
        name: `Человек ${index}`,
        surname: "Проверка",
        patronymic: "",
        birth: "1900",
        photo: undefined,
        parents:
          index > 0 && index < 4
            ? [`continuation-${index - 1}`]
            : index >= 4 && index < count + 4
              ? ["continuation-3"]
              : [],
        spouses: [],
        generation: index < 4 ? index + 1 : 5,
      }));
      data.family.links = [];
      data.family.unions = [];
      data.family.photos = [];
      data.partial = false;
      data.totals.people = 100;
      data.user.personId = "continuation-0";
      data.treePreferences = {
        ...data.treePreferences,
        fragmentThreshold: 100,
        animateOnLoad: false,
      };
      await route.fulfill({ response, json: data });
    });
    await page.goto("/tree");
    await page
      .getByRole("combobox", { name: /Найти человека/ })
      .fill("Человек 3");
    await page
      .getByRole("option", { name: /^Проверка Человек 3(?:\s|$)/ })
      .click();
    const card = page.locator('.flow-person[data-person-id="continuation-3"]');
    await expect(card).toBeInViewport({ ratio: 0.8 });
    const closeProfile = page.getByRole("button", { name: /Закрыть панель/ });
    await expect(closeProfile).toBeVisible();
    await closeProfile.click();
    const button = card.getByRole("button", {
      name: `Ещё ${count} ${label}: Проверка Человек 3`,
      exact: true,
    });
    await expect(button).toHaveText(`Ещё ${count}`);
    // Inspect the actual geometry at the displayed zoom, rather than only CSS.
    const geometry = await button.evaluate((element) => {
      const button = element.getBoundingClientRect();
      const card = element.closest(".flow-person")!.getBoundingClientRect();
      return {
        rightInset:
          ((card.right - button.right) * (element as HTMLElement).offsetWidth) /
          button.width,
        fontSize: getComputedStyle(element).fontSize,
        radius: getComputedStyle(element).borderRadius,
        fits:
          element.querySelector("span")!.getBoundingClientRect().left >=
            button.left - 0.5 &&
          element.querySelector("span")!.getBoundingClientRect().right <=
            button.right + 0.5,
        hitHeight:
          (parseFloat(getComputedStyle(element, "::before").height) *
            button.width) /
          (element as HTMLElement).offsetWidth,
      };
    });
    expect(geometry.rightInset).toBeCloseTo(10, 0);
    expect(geometry.fontSize).toBe(
      info.project.name === "mobile" ? "14px" : "12px",
    );
    expect(geometry.radius).toBe("7px");
    expect(geometry.fits).toBe(true);
    expect(geometry.hitHeight).toBeGreaterThanOrEqual(
      info.project.name === "mobile" ? 44 : 24,
    );
    expect(await card.locator(".flow-collapse").count()).toBe(0);
    await page.screenshot({
      path: info.outputPath(`continuation-button-${count}.png`),
    });
    if (info.project.name === "mobile") {
      await button.tap();
    } else {
      await button.focus();
      await expect(button).toBeFocused();
      await page.keyboard.press("Enter");
    }
    const dialog = page.getByRole("dialog", { name: "Продолжение ветвей" });
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".tree-canvas")).toHaveAttribute(
      "data-layout-people",
      String(4 + count),
    );
    await page.screenshot({
      path: info.outputPath(`continuation-${count}.png`),
    });
    // Cards outside the viewport are deliberately unmounted. In a wide family
    // the first child can be off-screen while its siblings appear below the owner.
    const descendants = page.locator(
      Array.from(
        { length: count },
        (_, index) =>
          `.flow-person[data-person-id="continuation-${index + 4}"]`,
      ).join(","),
    );
    await expect(descendants.first()).toBeAttached();
    const collapse = card.getByRole("button", {
      name: /Свернуть раскрытую ветвь/,
    });
    await expect(collapse).toHaveText("Свернуть");
    await expect(page.locator(".tree-canvas")).toHaveAttribute(
      "data-layout-ready",
      "true",
    );
    await collapse.click();
    await expect(page.locator(".tree-canvas")).toHaveAttribute(
      "data-layout-people",
      "4",
    );
    await expect(button).toHaveText(`Ещё ${count}`);
    await expect(dialog).toHaveCount(0);
  });
}

test("a large tree starts as a fragment, shows real continuations and keeps the personal threshold after reload", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let threshold = 500;
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    const template = data.family.people[0];
    data.family.people = Array.from({ length: 500 }, (_, n) => ({
      ...template,
      id: `fragment-${n}`,
      name: `Человек ${n}`,
      surname: "Проверка",
      patronymic: "",
      birth: "1900",
      sex: "u",
      photo: undefined,
      parents: n ? [`fragment-${n - 1}`] : [],
      spouses: [],
      generation: n + 1,
    }));
    data.family.links = [];
    data.family.unions = [];
    data.totals.people = 500;
    data.user.personId = "fragment-250";
    data.treePreferences = {
      reverseTimeline: false,
      cardVariant: "portrait",
      colorScheme: "warm",
      animateOnLoad: false,
      fragmentThreshold: threshold,
    };
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/tree-preferences", async (route) => {
    const preferences = route.request().postDataJSON();
    threshold = preferences.fragmentThreshold;
    await route.fulfill({ json: preferences });
  });
  await page.goto("/tree");
  const status = page.getByRole("region", { name: "Фрагмент большого древа" });
  await expect(status).toContainText(/Фрагмент: \d+ из 500/);
  // The fragment count precedes the worker result. A transient enabled frame
  // before layout starts does not mean its branch controls are ready yet.
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-layout-ready",
    "true",
  );
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-layout-settling/,
  );
  await page
    .getByRole("combobox", { name: /Найти человека/ })
    .fill("Человек 247");
  await page
    .getByRole("option", { name: /^Проверка Человек 247(?:\s|$)/ })
    .click();
  await page.getByRole("button", { name: /Закрыть панель/ }).click();
  const boundary = page.locator('.flow-person[data-person-id="fragment-247"]');
  const initialSize = Number(
    await page.locator(".tree-canvas").getAttribute("data-layout-people"),
  );
  await boundary.getByRole("button", { name: /^Ещё 1 родственник:/ }).click();
  const dialog = page.getByRole("dialog", { name: "Продолжение ветвей" });
  await expect(dialog).toHaveCount(0);
  await expect(
    status.getByRole("button", { name: "Продолжения ветвей" }),
  ).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-layout-people",
    String(initialSize + 1),
  );
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-fragment-anchor",
    "fragment-250",
  );
  await expect(status).toBeVisible();
  await page
    .getByRole("button", { name: "Настройки древа", exact: true })
    .click();
  const preferences = page.getByRole("dialog", { name: "Вид древа" });
  await preferences
    .getByLabel("Порог автоматических фрагментов")
    .selectOption("1000");
  await expect(status).not.toBeVisible();
  await page.reload();
  await expect(status).not.toBeVisible();
  await page
    .getByRole("button", { name: "Настройки древа", exact: true })
    .click();
  await expect(page.getByLabel("Порог автоматических фрагментов")).toHaveValue(
    "1000",
  );
});
