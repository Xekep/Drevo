import { test, expect } from "@playwright/test";

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
    await expect(button).toHaveText(`Ещё ${count} ${label}`);
    // Inspect the actual geometry at the displayed zoom, rather than only CSS.
    const geometry = await button.evaluate((element) => {
      const button = element.getBoundingClientRect();
      const card = element.closest(".flow-person")!.getBoundingClientRect();
      return {
        center: button.x + button.width / 2 - card.x - card.width / 2,
        gap: button.top - card.bottom,
        fits: element.scrollWidth <= element.clientWidth + 1,
        hitHeight:
          (parseFloat(getComputedStyle(element, "::before").height) *
            button.width) /
          (element as HTMLElement).offsetWidth,
      };
    });
    expect(Math.abs(geometry.center)).toBeLessThan(1);
    expect(geometry.gap).toBeGreaterThan(0);
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
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Ребёнок/ })).toHaveCount(
      Math.min(count, 30),
    );
    await page.screenshot({
      path: info.outputPath(`continuation-${count}.png`),
    });
    await dialog.getByRole("button", { name: "Раскрыть ветви здесь" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.locator('.flow-person[data-person-id="continuation-4"]'),
    ).toBeAttached();
    await expect(
      card.getByRole("button", { name: /Свернуть раскрытую ветвь/ }),
    ).toHaveText("Свернуть");
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
  await status.getByRole("button", { name: "Продолжения ветвей" }).click();
  const dialog = page.getByRole("dialog", { name: "Продолжение ветвей" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Родитель|Ребёнок/ }).first(),
  ).toBeVisible();
  const next = dialog.getByRole("button", { name: /Родитель|Ребёнок/ }).first();
  const nextId = /Человек (\d+)/.exec(await next.innerText())![1];
  await next.click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.locator(
      `.flow-person[data-person-id="fragment-${nextId}"][data-anchor="true"]`,
    ),
  ).toHaveCount(1);
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
