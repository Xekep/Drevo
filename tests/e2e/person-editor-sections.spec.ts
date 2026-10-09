import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family, FamilyUnion } from "../../src/domain/types.ts";

async function editor(page: Page, unions: FamilyUnion[] = []) {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  let family = (await (await page.request.get("/api/family")).json())
    .family as Family;
  family.unions = unions;
  const child = family.people.find((person) => person.id === "e2e-child")!;
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
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  return () => family;
}

test("отдельные образование и брак, поиск только супругов и единое сохранение", async ({
  page,
  isMobile,
}, info) => {
  const read = await editor(page);
  if (isMobile) await page.setViewportSize({ width: 320, height: 720 });
  const form = page.locator(".person-editor-form");
  await expect(form).toBeVisible();
  await page.screenshot({
    path: info.outputPath("person-editor-overview.png"),
  });
  await form.locator(".education-editor > summary").click();
  const school = form.locator(".education-editor .life-event-editor");
  await school.locator(":scope > summary").click();
  await school.getByLabel("Дата", { exact: true }).fill("1982");
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
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
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
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
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
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(read().unions![0]).toEqual(unions[0]);
  expect(read().unions![1]).toEqual({
    ...unions[1],
    formation: { date: "2002", confidence: undefined },
    divorce: { date: "2010", confidence: undefined },
  });
});
