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

test("a failed collection read shows a retry action instead of an endless spinner", async ({
  page,
}) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.totals.photos = 1;
    await route.fulfill({ response, json: data });
  });
  let attempts = 0;
  await page.route(
    "**/api/family?projection=page&collection=photos&**",
    (route) => {
      if (++attempts === 1)
        return route.fulfill({
          status: 503,
          json: { error: "Временно недоступно" },
        });
      const token = new URL(route.request().url()).searchParams.get("token");
      return route.fulfill({
        json: {
          pageToken: token,
          total: 1,
          items: [
            {
              id: "retry-photo",
              title: "Повторный снимок",
              event: "Повторный снимок",
              url: "/media/retry.png",
              tags: [],
            },
          ],
        },
      });
    },
  );
  await page.goto("/photos");
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Временно недоступно" });
  await expect(error).toBeVisible();
  await error.getByRole("button", { name: "Повторить загрузку" }).click();
  await expect(error).toHaveCount(0);
  await page.getByRole("button", { name: "Все · по добавлению" }).click();
  await expect(
    page.getByText("Повторный снимок", { exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

test("a minimal save reply preserves album pages loaded while the write was in flight", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = await (await page.request.get("/api/family")).json();
  const family = structuredClone(snapshot.family) as Family;
  const person = family.people.find((p) => p.id === "e2e-child")!;
  const photos = Array.from({ length: 41 }, (_, index) => ({
    id: `album-${index}`,
    title: `Фото ${index}`,
    url: "/media/synthetic-album.png",
    tags: [
      {
        id: `tag-${index}`,
        personId: person.id,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    ],
  }));
  let releasePage!: () => void, releaseSave!: () => void;
  const pageGate = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let writeStarted = false,
    secondPageFinished = false;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({
      json: {
        ...snapshot,
        family: archiveOverview(family),
        partial: true,
        pageToken: "1:fixture",
        totals: { people: family.people.length, photos: 41 },
      },
    }),
  );
  await page.route("**/api/family?projection=details&**", async (route) => {
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset"),
    );
    if (offset) await pageGate;
    await route.fulfill({
      json: {
        pageToken: "1:fixture",
        people: [personDetails(person)],
        photos: photos.slice(offset, offset + 40),
        photoTotal: photos.length,
      },
    });
    if (offset) secondPageFinished = true;
  });
  await page.route("**/api/family/changes", async (route) => {
    writeStarted = true;
    await saveGate;
    await route.fulfill({
      json: {
        revision: snapshot.revision + 1,
        appliedChanges: route.request().postDataJSON().changes,
      },
    });
  });
  try {
    await page.goto("/people/e2e-child");
    const dock = page.locator(".inspector-dock");
    await expect(
      dock.getByRole("button", {
        name: "Открыть фотоальбом человека: 40 фото",
        exact: true,
      }),
    ).toBeVisible();
    await dock.locator(".person-edit-button").click();
    await page
      .locator('.person-editor-form input[data-field="name"]')
      .fill("Тестов Александр Иванович");
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect.poll(() => writeStarted).toBe(true);
    releasePage();
    await expect.poll(() => secondPageFinished).toBe(true);
    // Editing replaces the inspector. Let the completed detail response commit
    // in the browser before releasing the independent write response.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    releaseSave();
    await expect(
      page.getByRole("heading", { name: "Редактировать человека" }),
    ).toHaveCount(0);
    await expect(
      dock.getByRole("button", {
        name: "Открыть фотоальбом человека: 41 фото",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    releasePage();
    releaseSave();
  }
});

test("a collection revision conflict reloads details of the person already open", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = await (await page.request.get("/api/family")).json();
  const family = structuredClone(snapshot.family) as Family;
  const person = family.people.find((item) => item.id === "e2e-child")!;
  let revision = 1,
    details = 0,
    conflict = true;
  person.biography = "До изменения в другой вкладке";
  const token = () => `${revision}:fixture`;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({
      json: {
        ...snapshot,
        family: archiveOverview(family),
        revision,
        partial: true,
        pageToken: token(),
        totals: { people: family.people.length, photos: 1 },
      },
    }),
  );
  await page.route("**/api/family?projection=details&**", (route) => {
    details++;
    const ids = JSON.parse(
      new URL(route.request().url()).searchParams.get("ids")!,
    ) as string[];
    return route.fulfill({
      json: {
        pageToken: token(),
        people: family.people
          .filter((p) => ids.includes(p.id))
          .map(personDetails),
        photos: [],
        photoTotal: 0,
      },
    });
  });
  await page.route(
    "**/api/family?projection=page&collection=photos&**",
    (route) => {
      if (conflict) {
        conflict = false;
        revision++;
        person.biography = "Изменение из другой вкладки";
        return route.fulfill({ status: 409, json: {} });
      }
      return route.fulfill({
        json: {
          pageToken: token(),
          total: 1,
          items: [
            {
              id: "unrelated-photo",
              title: "Снимок",
              url: "/media/synthetic-album.png",
              tags: [],
            },
          ],
        },
      });
    },
  );
  await page.goto("/people/e2e-child");
  const dock = page.locator(".inspector-dock");
  await expect(
    dock.getByText("До изменения в другой вкладке", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".nav-sections")
    .getByRole("link", { name: "Фото", exact: true })
    .click();
  await expect.poll(() => details).toBe(2);
  await expect(
    dock.getByText("Изменение из другой вкладки", { exact: true }),
  ).toHaveCount(1);
  await page
    .locator(".nav-sections")
    .getByRole("link", { name: "Древо", exact: true })
    .click();
  await expect(
    dock.getByText("Изменение из другой вкладки", { exact: true }),
  ).toBeVisible();
  expect(details).toBe(2);
});

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
  const detailRequests: string[][] = [];

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
  await page.route("**/api/family?projection=details&**", async (route) => {
    const ids = JSON.parse(
      new URL(route.request().url()).searchParams.get("ids")!,
    ) as string[];
    detailRequests.push(ids);
    await released;
    await route.fulfill({
      json: {
        pageToken: token,
        people: family.people
          .filter((person) => ids.includes(person.id))
          .map(personDetails),
        photos: [],
        photoTotal: 0,
      },
    });
  });
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
  return { releaseDetails, writes, detailRequests, current: () => family };
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
    await expect(page.getByTestId("rf__node-e2e-child")).toBeVisible();
    await expect(page.locator(".archive-loading-details")).toHaveCount(0);
    expect(archive.detailRequests).toEqual([]);
    await page
      .getByTestId("rf__node-e2e-child")
      .locator(".flow-person-content")
      .click();
    await expect(dock).toBeVisible();
    await expect(
      dock.getByRole("status", { name: "Загрузка сведений человека" }),
    ).toBeVisible();
    await expect.poll(() => archive.detailRequests).toEqual([["e2e-child"]]);
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
    // Name matching also finds patronymics such as Петрович/Петровна.
    const result = results.getByRole("option", {
      name: /^Тестов Пётр Иванович /,
    });
    await expect(result).toBeVisible();
    await result.click();
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
