import { expect, test } from "@playwright/test";
import { applyArchiveChanges } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

test("selected archive owns conflict reconciliation, portrait upload and resource reads", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "The editor workflow is verified on desktop",
  );
  const user = {
    id: "local",
    name: "Тест",
    role: "admin",
    approved: true,
    createdAt: "",
    treeAccess: "all",
  };
  let family: Family = {
    title: "Выбранный архив",
    description: "",
    demo: false,
    people: [
      {
        id: "selected-person",
        name: "Иван",
        surname: "Тестов",
        patronymic: "",
        sex: "m",
        birth: "1950",
        birthPlace: "",
        parents: [],
        spouses: [],
        sources: [],
        column: 0,
        generation: 1,
      },
    ],
    photos: [
      {
        id: "portrait",
        url: "/media/portrait.png",
        title: "Портрет для теста",
        tags: [
          {
            id: "tag",
            personId: "selected-person",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        ],
      },
    ],
  };
  let revision = 10,
    conflict = true;
  const reads: string[] = [],
    writes: string[] = [];
  const snapshot = () => ({
    family,
    revision,
    canEdit: true,
    local: true,
    user,
    readTree: true,
    readPhotos: true,
    treePreferences: {},
  });
  await page.route("**/media/portrait.png*", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlKIAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      reads.push(path);
      if (path.endsWith("/api/family"))
        return route.fulfill({ json: snapshot() });
      if (path.endsWith("/api/session"))
        return route.fulfill({
          json: { user, local: true, canEdit: true, account: null },
        });
      if (path.endsWith("/api/research-resources"))
        return route.fulfill({ json: { categories: [] } });
      return route.fulfill({
        json: { items: [], comments: [], categories: [] },
      });
    }
    writes.push(path);
    if (path.endsWith("/api/portraits"))
      return route.fulfill({ json: { url: "/media/portrait.png" } });
    if (conflict) {
      conflict = false;
      revision++;
      family = { ...family, description: "Правка из другой вкладки" };
      return route.fulfill({ status: 409, json: { error: "Архив изменился" } });
    }
    family = applyArchiveChanges(family, request.postDataJSON().changes).family;
    revision++;
    return route.fulfill({ json: { family, revision } });
  });
  await page.goto("/a/selected-archive/people/selected-person");
  const edit = page.locator(".inspector-person-actions .person-edit-button");
  await edit.click();
  await page.getByText("Жизнь и занятия", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "История человека" })
    .fill("Сохранено в выбранном архиве");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  await expect(
    page.getByRole("textbox", { name: "История человека" }),
  ).toHaveCount(0);
  expect(family.people[0].biography).toBe("Сохранено в выбранном архиве");
  expect(family.description).toBe("Правка из другой вкладки");
  await edit.click();
  await page
    .getByRole("button", { name: "Выбрать портрет из фотографий человека" })
    .click();
  await page.locator(".portrait-gallery button").first().click();
  await page.getByRole("button", { name: "Использовать портрет" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect
    .poll(() => writes.some((path) => path.endsWith("/api/portraits")))
    .toBe(true);
  await page.goto("/a/selected-archive/resources");
  await expect
    .poll(() => reads.some((path) => path.endsWith("/api/research-resources")))
    .toBe(true);
  expect(
    writes.every((path) => path.startsWith("/a/selected-archive/api/")),
  ).toBe(true);
  expect(
    reads
      .filter(
        (path) =>
          path.endsWith("/api/family") ||
          path.endsWith("/api/research-resources"),
      )
      .every((path) => path.startsWith("/a/selected-archive/api/")),
  ).toBe(true);
});
