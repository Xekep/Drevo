import { expect, test, type Locator, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

async function isolatedFamily(page: Page, legacyEvent = false) {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  const complete = await page.request.get("/api/family");
  const full = await complete.json();
  let family = structuredClone(full.family) as Family;
  if (legacyEvent) family.people.find((person) => person.id === "e2e-child")!.events = [{
    id: "legacy-repository-event", type: "residence", date: "1901",
    sources: [{ title: "Перепись", type: "", reference: "" }],
  }];
  let revision = full.revision as number;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ response, json: { ...initial, family, revision, partial: false } }),
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
  return () => family;
}

async function fillRepository(
  scope: ReturnType<Page["locator"]>,
  suffix: string,
) {
  await scope
    .getByRole("button", { name: "Добавить хранилище источника" })
    .click();
  await scope.getByLabel("Название хранилища (NAME)").fill(`Архив ${suffix}`);
  await scope.getByLabel("Шифр хранилища (CALN)").fill(`Ф. ${suffix}`);
  await scope
    .getByLabel("Сайт хранилища (WWW)")
    .fill(`https://archive.example/${suffix}`);
  await scope
    .getByLabel("Примечание хранилища", { exact: true })
    .fill(`Фонд ${suffix}`);
  await scope
    .getByLabel("Примечание о хранении (REPO.NOTE)")
    .fill(`Опись ${suffix}`);
}

async function ensureOpen(details: Locator) {
  if (
    !(await details.evaluate((element) => (element as HTMLDetailsElement).open))
  ) {
    await details.locator(":scope > summary").click();
  }
}

test("inline хранилище сохраняется у источника человека и события", async ({
  page,
}) => {
  const readFamily = await isolatedFamily(page, true);
  await page.goto("/tree");
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page
    .locator(".form-details > summary")
    .filter({ hasText: /^Источники$/ })
    .click();
  await page.getByRole("button", { name: "+ Источник", exact: true }).click();
  const personSource = page.locator(".source-editor").last();
  await personSource.getByLabel("Название").fill("Метрическая книга");
  await fillRepository(personSource, "12");

  await ensureOpen(page.locator(".event-editor"));
  const event = page.locator(".life-event-editor").last();
  await event.locator(":scope > summary").click();
  await event.getByLabel("Дата", { exact: true }).fill("1901");
  await event.locator(".event-extra > summary").click();
  await expect(event.getByRole("button", { name: "Добавить источник", exact: true })).toHaveCount(0);
  const eventSource = event.locator(".event-source-editor").last();
  await eventSource.getByLabel("Источник").fill("Перепись");
  await fillRepository(eventSource, "13");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect
    .poll(
      () =>
        readFamily()
          .people.find((p) => p.id === "e2e-child")
          ?.events?.find((event) => event.date === "1901")?.sources?.[0]
          ?.repository?.name,
    )
    .toBe("Архив 13");
  const person = readFamily().people.find((p) => p.id === "e2e-child")!;
  expect(
    person.sources.find((source) => source.title === "Метрическая книга")
      ?.repository,
  ).toEqual({
    name: "Архив 12",
    callNumber: "Ф. 12",
    website: "https://archive.example/12",
    note: "Фонд 12",
    linkNote: "Опись 12",
  });
  expect(
    person.events!.find((event) => event.date === "1901")!.sources![0]
      .repository,
  ).toEqual({
    name: "Архив 13",
    callNumber: "Ф. 13",
    website: "https://archive.example/13",
    note: "Фонд 13",
    linkNote: "Опись 13",
  });

  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page
    .locator(".form-details > summary")
    .filter({ hasText: /^Источники$/ })
    .click();
  const savedPersonSource = page.locator(".source-editor").last();
  await ensureOpen(savedPersonSource.locator(".source-repository-editor"));
  await savedPersonSource.getByLabel("Шифр хранилища (CALN)").fill("Ф. 12а");
  await ensureOpen(page.locator(".event-editor"));
  const savedEvent = page
    .locator(".life-event-editor")
    .filter({ hasText: "1901" });
  await savedEvent.locator(":scope > summary").click();
  await ensureOpen(savedEvent.locator(".event-extra"));
  await ensureOpen(savedEvent.locator(".source-repository-editor"));
  await savedEvent
    .getByRole("button", { name: "Убрать сведения о хранилище" })
    .click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect
    .poll(
      () =>
        readFamily()
          .people.find((p) => p.id === "e2e-child")
          ?.sources.find((source) => source.title === "Метрическая книга")
          ?.repository?.callNumber,
    )
    .toBe("Ф. 12а");
  expect(
    readFamily()
      .people.find((p) => p.id === "e2e-child")!
      .events!.find((event) => event.date === "1901")!.sources![0].repository,
  ).toBeUndefined();
});

test("inline хранилище сохраняется у союза и этапа", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const readFamily = await isolatedFamily(page);
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
  const edge = page.getByRole("group", {
    name: "Тестов Пётр Иванович — Тестова Елена Сергеевна",
  });
  await edge.focus();
  await edge.press("Enter");
  const panel = page.getByRole("region", { name: "Семейные союзы" });
  await panel.getByRole("button", { name: "Добавить союз" }).click();
  const unionSources = panel.getByRole("group", { name: "Источники союза" });
  await unionSources
    .getByRole("button", { name: "Добавить источник вручную" })
    .click();
  await unionSources.getByLabel("Название").fill("Семейная запись");
  await fillRepository(unionSources.locator(".union-inline-citation"), "21");
  const formation = panel.getByRole("group", { name: "Заключение" });
  await formation.getByText("Источники этапа (0)").click();
  await formation
    .getByRole("button", { name: "Добавить источник вручную" })
    .click();
  await formation.getByLabel("Название").fill("Книга браков");
  await fillRepository(formation.locator(".union-inline-citation"), "22");
  await panel.getByRole("button", { name: "Сохранить союз" }).click();
  await expect
    .poll(
      () =>
        readFamily().unions?.find((union) =>
          union.sources?.some((source) => source.title === "Семейная запись"),
        )?.formation?.sources?.[0]?.repository?.name,
    )
    .toBe("Архив 22");
  const union = readFamily().unions!.find(
    (item) => item.sources?.[0]?.title === "Семейная запись",
  )!;
  expect(union.sources![0].repository?.callNumber).toBe("Ф. 21");
  expect(union.formation!.sources![0].repository?.website).toBe(
    "https://archive.example/22",
  );
});

test("пустое NAME нельзя спрятать или сохранить незаметно", async ({
  page,
}) => {
  const readFamily = await isolatedFamily(page);
  const beforeSources = structuredClone(
    readFamily().people.find((person) => person.id === "e2e-child")!.sources,
  );
  await page.goto("/tree");
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page
    .locator(".form-details > summary")
    .filter({ hasText: /^Источники$/ })
    .click();
  await page.getByRole("button", { name: "+ Источник", exact: true }).click();
  const source = page.locator(".source-editor").last();
  await source.getByLabel("Название").fill("Неоконченная запись");
  await source
    .getByRole("button", { name: "Добавить хранилище источника" })
    .click();
  const repository = source.locator(".source-repository-editor");
  await repository.locator(":scope > summary").click();
  await expect(repository).toHaveAttribute("open", "");
  await expect(repository.getByRole("alert")).toHaveText(
    "Укажите название хранилища перед сохранением.",
  );
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator(".person-editor-form .form-error")).toHaveText(
    "Укажите название хранилища перед сохранением.",
  );
  expect(
    readFamily().people.find((person) => person.id === "e2e-child")?.sources,
  ).toEqual(beforeSources);
  await repository.getByLabel("Название хранилища (NAME)").fill("Архив");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect
    .poll(
      () =>
        readFamily()
          .people.find((person) => person.id === "e2e-child")
          ?.sources.find((source) => source.title === "Неоконченная запись")
          ?.repository?.name,
    )
    .toBe("Архив");
});
