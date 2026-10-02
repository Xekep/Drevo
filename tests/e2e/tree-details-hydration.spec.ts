import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import {
  archiveOverview,
  personDetails,
} from "../../src/domain/archive-projection.ts";
import type { Family } from "../../src/domain/types.ts";

const biography = "Работал в семейной мастерской, сохранил историю посёлка.";
const occupation = "Мастер архивной реставрации";
const sourceTitle = "Личное дело из догруженной страницы";
const awardName = "Почётная грамота семейной мастерской";

async function pagedArchive(page: Page, holdDetails = false) {
  const snapshot = await (await page.request.get("/api/family")).json();
  let family = structuredClone(snapshot.family) as Family;
  family.photos = [];
  const person = family.people.find((item) => item.id === "e2e-child")!;
  person.biography = biography;
  person.occupation = occupation;
  person.sources = [
    { title: sourceTitle, type: "архив", reference: "Ф. 1, д. 2" },
  ];
  person.awards = [{ id: "hydrated-award", name: awardName, year: "1985" }];
  person.photo = "/favicon.svg";
  person.needsReview = false;
  const token = "controlled-details-hydration";
  let releaseDetails = () => {};
  const released = new Promise<void>((resolve) => {
    releaseDetails = resolve;
  });
  if (!holdDetails) releaseDetails();
  let revision = snapshot.revision as number;
  const writes: Change[][] = [];

  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({
      json: {
        ...snapshot,
        family: archiveOverview(family),
        revision,
        partial: true,
        pageToken: token,
        totals: { people: family.people.length, photos: 0 },
      },
    }),
  );
  await page.route(
    "**/api/family?projection=page&collection=people&**",
    async (route) => {
      await released;
      await route.fulfill({
        json: {
          pageToken: token,
          total: family.people.length,
          items: family.people.map(personDetails),
        },
      });
    },
  );
  await page.route("**/api/family/changes", async (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    expect(route.request().headers()["if-match"]).toBe(String(revision));
    const result = applyArchiveChanges(family, changes);
    expect(result.conflicts).toEqual([]);
    family = result.family;
    writes.push(changes);
    revision++;
    // Exercise the ordinary minimal-reply path without changing the server fixture.
    await route.fulfill({ json: { revision, appliedChanges: changes } });
  });
  return { releaseDetails, writes, current: () => family };
}

test("догруженные сведения доступны в открытой карточке и после поиска", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const archive = await pagedArchive(page, true);
  const dock = page.locator(".inspector-dock");
  try {
    await page.goto("/tree");
    await expect(page.locator(".archive-loading-details")).toBeVisible();
    await page
      .getByTestId("rf__node-e2e-child")
      .locator(".flow-person-content")
      .click();
    await expect(dock).toBeVisible();
    await expect(dock.getByText(biography, { exact: true })).toHaveCount(0);
    await expect(
      dock.getByRole("button", { name: new RegExp(awardName) }),
    ).toHaveCount(0);

    archive.releaseDetails();
    await expect(page.locator(".archive-loading-details")).toHaveCount(0);
    await expect(dock.getByText(biography, { exact: true })).toBeVisible();
    await expect(
      dock.getByRole("heading", { name: occupation, exact: true }),
    ).toBeVisible();
    await expect(
      dock.getByRole("button", { name: new RegExp(awardName) }),
    ).toBeVisible();
    await dock.getByRole("tab", { name: /Источники/ }).click();
    await expect(dock.getByText(sourceTitle, { exact: true })).toBeVisible();
    await dock.getByRole("button", { name: "Закрыть панель" }).click();

    // Existing search supports names/places, not biography text. A nonempty query
    // must still open the current complete person, not the retained overview.
    const search = page.getByRole("combobox", { name: /Найти человека/ });
    await search.fill("Пётр Москва");
    const results = page.getByRole("listbox", { name: /Найденные люди/ });
    await expect(results.getByRole("option")).toHaveCount(1);
    await results.getByRole("option").click();
    await dock.getByRole("tab", { name: "О человеке", exact: true }).click();
    await expect(dock.getByText(biography, { exact: true })).toBeVisible();
    await expect(
      dock.getByRole("heading", { name: occupation, exact: true }),
    ).toBeVisible();
    await expect(
      dock.getByRole("button", { name: new RegExp(awardName) }),
    ).toBeVisible();
    await dock.getByRole("tab", { name: /Источники/ }).click();
    await expect(dock.getByText(sourceTitle, { exact: true })).toBeVisible();
  } finally {
    archive.releaseDetails();
  }
});

test("редактирование обновляет имя, отметку проверки и портрет сохранённого древа", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const archive = await pagedArchive(page);
  await page.goto("/tree");
  await expect(page.locator(".archive-loading-details")).toHaveCount(0);
  const card = page.getByTestId("rf__node-e2e-child");
  await expect(card.locator(".person-avatar img")).toHaveAttribute(
    "src",
    "/favicon.svg",
  );
  await card.locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.getByText("ФИО и фамилия при рождении", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Имя", exact: true })
    .fill("Александр");
  await page.getByRole("checkbox", { name: "Требует проверки" }).check();
  await page
    .getByRole("button", { name: "Выбрать портрет из фотографий человека" })
    .click();
  await page
    .getByRole("button", { name: "Убрать портрет", exact: true })
    .click();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/family/changes") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Редактировать человека" }),
  ).toHaveCount(0);
  await expect(card.locator(".flow-person strong")).toContainText("Александр");
  await expect(card.locator(".flow-person")).toHaveClass(/is-needs-review/);
  await expect(card.locator(".flow-person-content")).toHaveAttribute(
    "aria-label",
    /Александр.*требует проверки/,
  );
  await expect(card.locator(".person-avatar img")).toHaveCount(0);
  expect(archive.writes).toHaveLength(1);
  expect(archive.writes[0].map((change) => change.field)).toEqual(
    expect.arrayContaining(["name", "needsReview", "photo"]),
  );
  const current = archive
    .current()
    .people.find((person) => person.id === "e2e-child")!;
  expect(current).toMatchObject({
    name: "Александр",
    needsReview: true,
    photo: "",
    biography,
    occupation,
  });
  expect(current.sources[0].title).toBe(sourceTitle);
  expect(current.awards?.[0].name).toBe(awardName);
  const dock = page.locator(".inspector-dock");
  await expect(dock.getByText(biography, { exact: true })).toBeVisible();
  await expect(
    dock.getByRole("button", { name: new RegExp(awardName) }),
  ).toBeVisible();
});
