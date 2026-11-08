import { savePersonDetails, finishPersonDetail } from "./person-editor-actions";
import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import { fullName } from "../../src/domain/dates.ts";
import type {
  Family,
  FamilyUnion,
  PersonAward,
} from "../../src/domain/types.ts";

async function editor(
  page: Page,
  unions: FamilyUnion[] = [],
  awards?: PersonAward[],
) {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  let family = (await (await page.request.get("/api/family")).json())
    .family as Family;
  family.unions = unions;
  const child = family.people.find((person) => person.id === "e2e-child")!;
  if (awards) child.awards = awards;
  child.events = [
    {
      id: "school",
      type: "education",
      date: "1980",
      description: "Школа",
      sources: [{ title: "Аттестат", type: "", reference: "5" }],
    },
    {
      id: "old-marriage",
      type: "marriage",
      date: "1988",
      description: "Импортированная запись",
    },
  ];
  child.sources = [{ title: "Семейная книга", type: "", reference: "12" }];
  let revision = initial.revision as number;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({
      response,
      json: { ...initial, family, revision, partial: false },
    }),
  );
  await page.route("**/api/family/changes", (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    const applied = applyArchiveChanges(family, changes);
    expect(applied.conflicts).toEqual([]);
    family = applied.family;
    revision++;
    return route.fulfill({
      json: { family, revision, appliedChanges: changes },
    });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toHaveAttribute("aria-busy", "false");
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  return () => family;
}

test("old style is explicit, disappears for modern dates and retains historical originals", async ({ page }) => {
  const read = await editor(page);
  const form = page.locator(".person-editor-form");
  const birth = form.locator('[data-field="birth"]');
  const death = form.locator('[data-field="death"]');
  await expect(form.getByRole("checkbox", { name: "Дата рождения по старому стилю" })).toHaveCount(0);
  await birth.fill("29.2.1900");
  await expect(form.getByRole("checkbox", { name: "Дата рождения по старому стилю" })).toBeVisible();
  await form.getByRole("checkbox", { name: "Дата рождения по старому стилю" }).check();
  await expect(form.getByText("Новый стиль: 13.03.1900", { exact: true })).toBeVisible();
  await birth.fill("25.12.2005");
  await expect(form.getByRole("checkbox", { name: "Дата рождения по старому стилю" })).toHaveCount(0);
  await birth.fill("29.2.1900");
  await form.getByRole("checkbox", { name: "Дата рождения по старому стилю" }).check();
  await death.fill("29.2.1912");
  await form.getByRole("checkbox", { name: "Дата смерти по старому стилю" }).check();
  await expect(form.getByText("Новый стиль: 13.03.1912", { exact: true })).toBeVisible();
  await savePersonDetails(page);
  await expect(form).toHaveCount(0);
  const saved = read().people.find(person => person.id === "e2e-child")!;
  expect(saved).toMatchObject({
    birth: "1900-03-13", birthJulian: "1900-02-29",
    death: "1912-03-13", deathJulian: "1912-02-29",
  });
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await expect(form.locator('[data-field="birth"]')).toHaveValue("29.02.1900");
  await expect(form.getByRole("checkbox", { name: "Дата рождения по старому стилю" })).toBeChecked();
});

test("Byzantine source date is a separate, explicit era, not an assumed Julian checkbox", async ({ page }) => {
  const read = await editor(page);
  const form = page.locator(".person-editor-form");
  const input = form.locator('[data-field="birth"]');
  await input.fill("1650");
  await expect(form.getByRole("checkbox", { name: "Дата рождения от Сотворения мира" })).toHaveCount(0);
  await input.fill("12.12.7159");
  await expect(form.getByRole("checkbox", { name: "Дата рождения по старому стилю" })).toHaveCount(0);
  await form.getByRole("checkbox", { name: "Дата рождения от Сотворения мира" }).check();
  await expect(form.getByText(/Новый стиль: 22.12.1650/)).toBeVisible();
  await savePersonDetails(page);
  await expect(form).toHaveCount(0);
  expect(read().people.find(person => person.id === "e2e-child")).toMatchObject({
    birth: "1650-12-22", birthJulian: "1650-12-12", birthByzantine: "7159-12-12",
  });
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await expect(form.locator('[data-field="birth"]')).toHaveValue("12.12.7159");
  await expect(form.getByRole("checkbox", { name: "Дата рождения от Сотворения мира" })).toBeChecked();
});

test("compact editor shows hints and errors without clipping or overlapping inputs", async ({ page }, info) => {
  await page.route("**/api/places/locate**", route => route.fulfill({ json: { candidates: [] } }));
  await editor(page);
  const form = page.locator(".person-editor-form");
  await expect(form.locator('[data-field="name"]')).toBeVisible();
  const checkFeedback = async () => {
    const problems = await form.evaluate((element) => {
      const inputs = [...element.querySelectorAll('input:not([type="checkbox"]), select')]
        .filter(input => input.getClientRects().length).map(input => input.getBoundingClientRect());
      return [...element.querySelectorAll('.person-field-feedback, .field-error, .calendar-style-control > small, .place-input-notice')]
        .filter(hint => hint.getClientRects().length && hint.textContent?.trim())
        .filter(hint => {
          const rect = hint.getBoundingClientRect();
          return hint.scrollHeight > hint.clientHeight + 1 || inputs.some(input =>
            rect.left < input.right && rect.right > input.left && rect.top < input.bottom && rect.bottom > input.top);
        }).map(hint => hint.textContent);
    });
    expect(problems).toEqual([]);
  };
  expect(await form.locator('.calendar-date-field > .field-error').first().evaluate(element => element.getBoundingClientRect().height)).toBe(0);
  await form.locator('[data-field="name"]').fill("Александр Иванов");
  await form.locator('[data-field="birth"]').fill("1880");
  await form.getByRole("checkbox", { name: "Дата рождения по старому стилю" }).check();
  await checkFeedback();
  await form.locator('[data-field="birth"]').fill("не дата");
  await form.locator('[data-field="death"]').focus();
  await expect(form.locator('[data-field="birth"]')).toHaveAttribute("aria-invalid", "true");
  await checkFeedback();
  await form.locator('.person-date-group').first().getByLabel("Место", { exact: true }).fill("Неизвестное место");
  await form.locator('[data-field="death"]').focus();
  await expect(form.locator(".place-input-notice").first()).toContainText("Название сохранится");
  await checkFeedback();
  await page.screenshot({ path: info.outputPath("stable-editor-hints.png") });
});

test("событие, образование и источник открываются по центру и применяются только через Готово", async ({ page }, info) => {
  const read = await editor(page);
  const form = page.locator(".person-editor-form");
  const initial = structuredClone(read().people.find((person) => person.id === "e2e-child")!);
  await form.locator(".event-editor > summary").click();
  await form.getByRole("button", { name: "Добавить событие", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Событие жизни", exact: true });
  const unloadPrevented = () => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  await expect.poll(unloadPrevented).toBe(false);
  await dialog.getByLabel("Дата", { exact: true }).fill("1991");
  await expect.poll(unloadPrevented).toBe(true);
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect.poll(unloadPrevented).toBe(false);
  await expect(form.locator(".event-editor .life-event-editor")).toHaveCount(0);
  await form.locator(".education-editor > summary").click();
  await form.getByRole("button", { name: "Добавить образование", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Образование", exact: true });
  const bounds = (await dialog.boundingBox())!, viewport = page.viewportSize()!;
  expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(bounds.width).toBeLessThanOrEqual(viewport.width - 16);
  await dialog.getByLabel("Учебное заведение").fill("Университет");
  await dialog.getByLabel("Дата", { exact: true }).fill("1985");
  await expect.poll(unloadPrevented).toBe(true);
  await page.screenshot({ path: info.outputPath("education-dialog.png") });
  await dialog.getByLabel("Дата", { exact: true }).press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(unloadPrevented).toBe(true);
  await expect(form).toBeVisible();
  expect(read().people.find((person) => person.id === initial.id)).toEqual(initial);
  await form.locator(".person-sources-editor > summary").click();
  await form.getByRole("button", { name: "+ Источник", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Источник", exact: true });
  await dialog.getByLabel("Название", { exact: true }).fill("Семейная запись");
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(form.locator(".source-editor")).toHaveCount(initial.sources.length);
  await savePersonDetails(page);
  await expect(form).toHaveCount(0);
  expect(read().people.find((person) => person.id === initial.id)!.events)
    .toContainEqual(expect.objectContaining({ type: "education", title: "Университет", date: "1985" }));
});

test("круглый портрет и награды с подписями без перестановки полей", async ({
  page,
  isMobile,
}, info) => {
  const awards: PersonAward[] = [
    {
      id: "courage",
      name: "Медаль «За отвагу»",
      year: "1945",
      awardDefinitionId: "ussr-medal-for-courage",
    },
    {
      id: "labour",
      name: "Медаль «Ветеран труда»",
      year: "1980",
      awardDefinitionId: "ussr-medal-veteran-labour",
    },
    {
      id: "custom",
      name: "Почётная грамота за многолетнюю работу и вклад в развитие предприятия",
      year: "1990",
    },
  ];
  const read = await editor(page, [], awards);
  const form = page.locator(".person-editor-form");
  const portrait = form.getByRole("button", {
    name: "Выбрать портрет из фотографий человека",
  });
  const name = form.locator('input[data-field="name"]');
  const awardEditor = form.locator(".person-editor-portrait-awards");
  for (const width of isMobile ? [320, 390] : [768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await form.evaluate((element) => {
      element.scrollTop = 0;
    });
    const circle = (await portrait.boundingBox())!;
    expect(Math.abs(circle.width - circle.height)).toBeLessThan(1);
    expect(circle.width).toBe(64);
    for (const award of awards) {
      const button = awardEditor.getByRole("button", {
        name: `Редактировать: ${award.name}`,
      });
      await expect(button.locator(".award-editor-label")).toContainText(
        award.name,
      );
      await expect(button.locator("small")).toHaveText(award.year!);
      const bounds = (await button.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(160);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      const labelFits = await button
        .locator(".award-editor-label")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
      expect(labelFits).toBe(true);
    }
    const before = (await name.boundingBox())!;
    await awardEditor
      .getByRole("button", { name: `Редактировать: ${awards[0].name}` })
      .click();
    await expect(
      awardEditor.getByRole("combobox", { name: "Название" }),
    ).toBeVisible();
    const after = (await name.boundingBox())!;
    expect(after.x).toBeCloseTo(before.x);
    expect(after.width).toBeCloseTo(before.width);
    expect(
      await form.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`person-awards-edit-${width}.png`),
    });
    await awardEditor
      .getByRole("button", { name: "Закрыть редактирование награды" })
      .click();
    await page.screenshot({
      path: info.outputPath(`person-awards-${width}.png`),
    });
  }
  await savePersonDetails(page);
  await expect(form).toHaveCount(0);
  expect(
    read().people.find((person) => person.id === "e2e-child")!.awards,
  ).toEqual(awards);
});

test("отдельные образование и брак, поиск только супругов и единое сохранение", async ({
  page,
  isMobile,
}, info) => {
  const read = await editor(page);
  if (isMobile) await page.setViewportSize({ width: 320, height: 720 });
  const form = page.locator(".person-editor-form");
  await expect(form).toBeVisible();
  for (const chip of await form.locator(".award-editor-chip").all()) {
    const box = (await chip.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const image = chip.locator("img");
    if (await image.count()) {
      const imageBox = (await image.boundingBox())!;
      expect(imageBox.x).toBeGreaterThanOrEqual(box.x);
      expect(imageBox.y).toBeGreaterThanOrEqual(box.y);
      expect(imageBox.x + imageBox.width).toBeLessThanOrEqual(
        box.x + box.width,
      );
      expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(
        box.y + box.height,
      );
    }
  }
  await page.screenshot({
    path: info.outputPath("person-editor-overview.png"),
  });
  await form.locator(".education-editor > summary").click();
  const school = form.locator(".education-editor .life-event-editor");
  await school.locator(":scope > summary").click();
  await school.getByLabel("Дата", { exact: true }).fill("1982");
  await finishPersonDetail(page);
  await form.locator(".person-marriages-editor > summary").click();
  const marriage = form.locator(".person-marriages-editor");
  const search = marriage.getByRole("combobox", { name: "Супруг / супруга" });
  await search.click();
  const options = marriage.getByRole("option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("Елена");
  await search.fill("Петрович");
  await expect(options).toHaveCount(0);
  await search.fill("Елена");
  await search.press("ArrowDown");
  await search.press("Enter");
  await marriage.getByLabel("Дата брака", { exact: true }).fill("1.5.1990");
  await marriage
    .getByRole("button", { name: "Выбрать другого супруга" })
    .click();
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(marriage.getByLabel("Дата брака", { exact: true })).toHaveValue(
    "1.5.1990",
  );
  await marriage.getByLabel("Дата развода", { exact: true }).fill("1980");
  await savePersonDetails(page);
  await expect(form.locator(".form-error")).toContainText("раньше заключения");
  expect(read().unions).toEqual([]);
  await marriage.getByLabel("Дата развода", { exact: true }).fill("2001");
  await marriage.locator(":scope > summary").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("person-editor-marriage.png"),
  });
  await form.getByLabel("Занятие", { exact: true }).fill("Инженер");
  await form
    .locator(".form-details > summary")
    .filter({ hasText: /^Источники$/ })
    .click();
  await expect(form.locator(".source-editor")).not.toHaveAttribute("open", "");
  await form.locator(".source-editor > summary").click();
  await form
    .locator(".source-editor")
    .getByLabel("Примечание", { exact: true })
    .fill("Из семейного архива");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("person-editor-compact.png") });
  await savePersonDetails(page);
  await expect(form).toHaveCount(0);
  const saved = read().people.find((person) => person.id === "e2e-child")!;
  expect(saved.occupation).toBe("Инженер");
  expect(saved.events!.find((event) => event.id === "school")).toEqual(
    expect.objectContaining({
      date: "1982",
      sources: [{ title: "Аттестат", type: "", reference: "5" }],
    }),
  );
  expect(saved.events!.find((event) => event.id === "old-marriage")?.date).toBe(
    "1988",
  );
  expect(saved.sources[0].note).toBe("Из семейного архива");
  expect(read().unions?.[0]).toEqual(
    expect.objectContaining({
      participants: ["e2e-child", "e2e-spouse"],
      formation: { date: "1990-05-01" },
      divorce: { date: "2001" },
    }),
  );
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await form.locator(".person-marriages-editor > summary").click();
  await search.fill("Елена");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(marriage.getByLabel("Дата брака", { exact: true })).toHaveValue(
    "01.05.1990",
  );
  await expect(
    marriage.getByLabel("Дата развода", { exact: true }),
  ).toHaveValue("2001");
});

test("брак и развод видны в обеих карточках и правка второго супруга обновляет первую", async ({ page }, info) => {
  const read = await editor(page);
  const originalEvents = structuredClone(read().people.map((person) => [person.id, person.events]));
  const first = read().people.find((person) => person.id === "e2e-child")!;
  const second = read().people.find((person) => person.id === "e2e-spouse")!;
  const form = page.locator(".person-editor-form");
  const marriage = form.locator(".person-marriages-editor");
  await marriage.locator(":scope > summary").click();
  await marriage.getByRole("combobox", { name: "Супруг / супруга" }).fill(fullName(second));
  await marriage.getByRole("option").click();
  await marriage.getByLabel("Дата брака", { exact: true }).fill("1990");
  await marriage.getByLabel("Дата развода", { exact: true }).fill("2001");
  await savePersonDetails(page);
  await expect(form).toHaveCount(0);
  const shared = page.locator(".person-unions");
  await expect(shared).toContainText("Заключение брака: 1990 год");
  await expect(shared).toContainText("Развод: 2001 год");
  await shared.locator(".person-union-partner").click();
  await expect(shared.locator(".person-union-partner")).toHaveText(fullName(first));
  await expect(shared).toContainText("Заключение брака: 1990 год");
  await expect(shared).toContainText("Развод: 2001 год");
  await shared.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("marriage-second-profile.png") });
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await marriage.locator(":scope > summary").click();
  await marriage.getByRole("combobox", { name: "Супруг / супруга" }).fill(fullName(first));
  await marriage.getByRole("option").click();
  await expect(marriage.getByLabel("Дата брака", { exact: true })).toHaveValue("1990");
  await marriage.getByLabel("Дата брака", { exact: true }).fill("1991");
  await marriage.getByLabel("Дата развода", { exact: true }).fill("2002");
  await savePersonDetails(page);
  await expect(form).toHaveCount(0);
  await shared.locator(".person-union-partner").click();
  await expect(shared.locator(".person-union-partner")).toHaveText(fullName(second));
  await expect(shared).toContainText("Заключение брака: 1991 год");
  await expect(shared).toContainText("Развод: 2002 год");
  await shared.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("marriage-first-profile.png") });
  expect(read().unions).toHaveLength(1);
  expect(read().unions![0]).toMatchObject({ formation: { date: "1991" }, divorce: { date: "2002" } });
  expect(read().people.map((person) => [person.id, person.events])).toEqual(originalEvents);
});

test("несколько браков одной пары редактируются по отдельности", async ({
  page,
}) => {
  const unions: FamilyUnion[] = [
    {
      id: "first",
      participants: ["e2e-child", "e2e-spouse"],
      type: "marriage",
      formation: { date: "1990" },
      divorce: { date: "1995" },
    },
    {
      id: "second",
      participants: ["e2e-child", "e2e-spouse"],
      type: "marriage",
      formation: { date: "2000" },
      note: "Повторный брак",
    },
  ];
  const read = await editor(page, unions);
  const form = page.locator(".person-editor-form");
  await form.locator(".person-marriages-editor > summary").click();
  const marriage = form.locator(".person-marriages-editor");
  await marriage
    .getByRole("combobox", { name: "Супруг / супруга" })
    .fill("Елена");
  await marriage.getByRole("option").click();
  await marriage.getByLabel("Брак с этим человеком").selectOption("second");
  await marriage.getByLabel("Дата брака", { exact: true }).fill("2002");
  await marriage.getByLabel("Дата развода", { exact: true }).fill("2010");
  await savePersonDetails(page);
  await expect(form).toHaveCount(0);
  expect(read().unions![0]).toEqual(unions[0]);
  expect(read().unions![1]).toEqual({
    ...unions[1],
    formation: { date: "2002", confidence: undefined },
    divorce: { date: "2010", confidence: undefined },
  });
});


test("saved marriages are listed before choosing a spouse and can be removed with the person save", async ({ page }, info) => {
  if (info.project.name === "mobile") await page.setViewportSize({ width: 320, height: 720 });
  const read = await editor(page, [{ id: "listed-marriage", type: "marriage",
    participants: ["e2e-child", "e2e-spouse"], formation: { date: "1990" } }]);
  const form = page.locator(".person-editor-form");
  const marriage = form.locator(".person-marriages-editor");
  await marriage.locator(":scope > summary").click();
  const records = marriage.getByRole("list", { name: "Записи о браках" });
  await expect(records.getByRole("button", { name: /1990/ })).toBeVisible();
  expect(await marriage.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await marriage.screenshot({ path: info.outputPath("listed-marriages.png") });
  await records.getByRole("button", { name: /1990/ }).click();
  await expect(marriage.getByLabel("Дата брака", { exact: true })).toHaveValue("1990");
  await records.getByRole("button", { name: /^Удалить запись о браке/ }).click();
  await expect(records).toHaveCount(0);
  expect(read().unions!.some(union => union.id === "listed-marriage")).toBe(true);
  await savePersonDetails(page);
  expect(read().unions!.some(union => union.id === "listed-marriage")).toBe(false);
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await marriage.locator(":scope > summary").click();
  await expect(marriage.getByRole("list", { name: "Записи о браках" })).toHaveCount(0);
});


for (const recorded of [false, true]) test(`spouse links are listed and removable with ${recorded ? "a recorded marriage" : "no marriage dates"}`, async ({ page }) => {
  const read = await editor(page, recorded ? [{ id: "remove-together", type: "marriage",
    participants: ["e2e-child", "e2e-spouse"], formation: { date: "1990" } }] : []);
  const partner = read().people.find(person => person.id === "e2e-spouse")!;
  const marriage = page.locator(".person-marriages-editor");
  await marriage.locator(":scope > summary").click();
  if (recorded) await marriage.getByRole("button", { name: `Удалить запись о браке с ${fullName(partner)}`, exact: true }).click();
  const records = marriage.getByRole("list", { name: "Связи супругов без записи о браке" });
  await expect(records.getByRole("button", { name: `${fullName(partner)} · Даты не указаны`, exact: true })).toBeVisible();
  await records.getByRole("button", { name: `Удалить связь супругов с ${fullName(partner)}`, exact: true }).click();
  await savePersonDetails(page);
  expect(read().people.find(person => person.id === "e2e-child")!.spouses).not.toContain(partner.id);
  expect(read().people.find(person => person.id === partner.id)!.spouses).not.toContain("e2e-child");
  expect(read().unions!.some(union => union.id === "remove-together")).toBe(false);
});
