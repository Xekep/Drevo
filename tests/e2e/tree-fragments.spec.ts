import { test, expect } from "@playwright/test";

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
  await dialog
    .getByRole("button", { name: /Родитель|Ребёнок/ })
    .first()
    .click();
  await expect(dialog).not.toBeVisible();
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
