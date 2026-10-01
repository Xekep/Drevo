import { expect, test } from "@playwright/test";

for (const [name, path] of [
  ["Древо", "/tree"],
  ["Люди", "/people"],
  ["Семьи", "/families"],
  ["Фото", "/photos"],
  ["Документы", "/documents"],
  ["Места", "/places"],
  ["Сводка", "/insights"],
  ["Ресурсы", "/resources"],
]) {
  test(`middle click opens ${path} in a new tab`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await page.goto("/tree");
    await page.bringToFront();
    const sections = page.locator(".nav-sections");
    const link = sections.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", path);
    const opened = context.waitForEvent("page");
    await link.click({ button: "middle" });
    const tab = await opened;
    await expect(tab).toHaveURL(new RegExp(`${path}$`));
    await expect(page).toHaveURL(/\/tree$/);
    await tab.close();
  });
}

test("data checks stay accessible from the summary without a menu item", async ({
  page,
}) => {
  await page.goto("/insights");
  await expect(
    page.locator(".nav-sections").getByRole("link", { name: "Проверка" }),
  ).toHaveCount(0);
  await expect(
    page.locator(".mobile-sections").getByRole("link", { name: "Проверка" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Проверить записи" }),
  ).toHaveCount(0);
  const link = page.getByRole("link", { name: "Проверить данные" });
  await expect(link).toHaveAttribute("href", "/quality");
  await link.click();
  await expect(page).toHaveURL(/\/quality$/);
  await expect(
    page.getByRole("heading", { name: "Проверка данных" }),
  ).toBeVisible();
});

test("modified clicks open a tab and plain clicks retain the application", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  await page.bringToFront();
  const sections = page.locator(".nav-sections");
  const opened = context.waitForEvent("page");
  await sections
    .getByRole("link", { name: "Люди", exact: true })
    .click({ modifiers: ["ControlOrMeta"] });
  const tab = await opened;
  await expect(tab).toHaveURL(/\/people$/);
  await tab.close();
  await page.bringToFront();
  // A normal click must retain the document and the application's state.
  const documentHandle = await page.evaluateHandle(() => document);
  await sections.getByRole("link", { name: "Люди", exact: true }).click();
  await expect(page).toHaveURL(/\/people$/);
  expect(await documentHandle.evaluate((old) => old === document)).toBe(true);
});

test("mobile section links keep native addresses and close the menu on navigation", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/tree");
  await page.getByLabel("Меню проекта").click();
  const people = page
    .locator(".mobile-sections")
    .getByRole("link", { name: "Люди", exact: true });
  await expect(people).toHaveAttribute("href", "/people");
  await people.click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.locator(".archive-more")).not.toHaveAttribute("open");
});

test("visible about link and account avatar keep the header usable", async ({
  page,
}, testInfo) => {
  await page.goto("/tree");
  const avatar = page.locator(".nav-account");
  const menu = page.locator(".archive-more > summary");
  const about = page.getByRole("button", { name: "О проекте", exact: true });
  await expect(about).toBeVisible();
  await about.click();
  await expect(page.getByRole("dialog", { name: "О проекте" })).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("link", { name: "Евгений С." }),
  ).toHaveAttribute("href", "https://vk.ru/xekep");
  await page.keyboard.press("Escape");
  await expect(about).toBeFocused();
  await expect(avatar).toHaveAttribute("href", "/account");
  await expect(avatar).toHaveAttribute("aria-label", /Личный кабинет/);
  await expect(avatar.locator(".nav-account-avatar")).toHaveText("Н");
  const avatarBox = await avatar.boundingBox();
  expect(avatarBox).not.toBeNull();
  if (testInfo.project.name === "mobile") {
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    expect(avatarBox!.x + avatarBox!.width).toBeLessThan(menuBox.x);
    const search = page.locator(".archive-search");
    expect((await search.boundingBox())!.width).toBeGreaterThan(150);
    await page.setViewportSize({ width: 320, height: 640 });
    await expect(about).toBeVisible();
    expect((await search.boundingBox())!.width).toBeGreaterThan(70);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
    await search.locator("input").fill("Тестов");
    const results = page.locator(".archive-search-results");
    await expect(results).toBeVisible();
    const resultsBox = (await results.boundingBox())!;
    expect(resultsBox.x).toBeGreaterThanOrEqual(0);
    expect(resultsBox.x + resultsBox.width).toBeLessThanOrEqual(320);
    await page.keyboard.press("Escape");
  } else {
    for (const width of [1201, 1101, 1024]) {
      await page.setViewportSize({ width, height: 720 });
      await expect(about).toBeVisible();
      if (width === 1024) {
        await expect(menu).toBeVisible();
        const menuBox = (await menu.boundingBox())!;
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
        await menu.click();
        await expect(
          page
            .locator(".mobile-sections")
            .getByRole("link", { name: "Люди", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
      } else {
        await expect(menu).toBeHidden();
        await expect(page.locator(".nav-sections")).toBeVisible();
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  if (testInfo.project.name === "mobile") {
    await menu.click();
    await expect(page.locator(".archive-more .nav-bottom")).not.toContainText(
      "О проекте",
    );
    await expect(page.locator(".archive-more .nav-bottom")).not.toContainText(
      "Личный кабинет",
    );
  } else {
    await expect(menu).toBeHidden();
  }
  await page.screenshot({
    path: testInfo.outputPath("account-avatar-header.png"),
  });
  await avatar.click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(avatar).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Личный кабинет" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Поиск опубликованных людей" }),
  ).toHaveAttribute("href", "/discover");
  await page.getByRole("region", { name: "Доступ и роль" }).getByRole("button", { name: "Управление архивом" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await avatar.click();
  await expect(
    page.getByRole("heading", { name: "Просмотр древа" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Изменить просмотр" }),
  ).toHaveCount(0);
});

test("account avatar uses the linked person's portrait when available", async ({
  page,
}) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = "e2e-memorial-person";
    data.family.people.find(
      (person: { id: string }) => person.id === data.user.personId,
    ).photo = "/media/nav-avatar.jpg";
    await route.fulfill({ response, json: data });
  });
  await page.route("**/media/nav-avatar.jpg?variant=thumb", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#688a70"/></svg>',
    }),
  );
  await page.goto("/tree");
  const image = page.locator(".nav-account-avatar img");
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
});

test("a guest can reach sign-in and public discovery from the profile", async ({
  page,
}) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, user: null, local: false } });
  });
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: { user: null, account: null, local: false, yandex: true, vk: true },
    }),
  );
  await page.goto("/account");
  await expect(page.locator(".nav-account")).toBeVisible();
  await expect(page.locator(".nav-account")).toHaveAttribute(
    "aria-label",
    "Личный кабинет",
  );
  await expect(
    page.getByRole("heading", { name: "Войдите в Drevo" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Управление архивом" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Выйти из этого сеанса" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Поиск опубликованных людей" }),
  ).toHaveAttribute("href", "/discover");
});

test("account cabinet shows the owner's current tier and quotas", async ({
  page,
}) => {
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        local: false,
        user: { ...data.user, fullAccess: false },
      },
    });
  });
  await page.route("**/api/account/capacity", (route) =>
    route.fulfill({
      json: {
        available: true,
        owned: true,
        fullAccess: false,
        people: 42,
        peopleLimit: 150,
        mediaBytes: 120_000_000,
        mediaLimitBytes: 500_000_000,
      },
    }),
  );
  await page.goto("/account");
  await expect(page.getByText("Уровень аккаунта")).toBeVisible();
  await expect(page.getByText("Базовый", { exact: true })).toBeVisible();
  await expect(page.getByText("42 из 150")).toBeVisible();
  await expect(page.getByText("120 МБ из 500 МБ")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Скачать дерево с фото и документами/ }),
  ).toHaveAttribute("href", "/api/gedcom/export?format=gedzip7");
  await expect(
    page.getByRole("link", { name: /Скачать данные дерева/ }),
  ).toHaveAttribute("href", "/api/gedcom/export?format=gedcom7");
  await expect(
    page.getByRole("link", { name: /Скачать полный переносимый архив/ }),
  ).toHaveAttribute("href", "/api/drevo/export");
});

test("empty archive owner previews a portable import before applying", async ({
  page,
}) => {
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        local: false,
        user: { ...data.user, fullAccess: false },
      },
    });
  });
  await page.route("**/api/account/capacity", (route) =>
    route.fulfill({
      json: {
        available: true,
        owned: true,
        fullAccess: false,
        people: 0,
        peopleLimit: 150,
        mediaBytes: 0,
        mediaLimitBytes: 500_000_000,
      },
    }),
  );
  await page.route("**/api/account/owner-transfer", (route) =>
    route.fulfill({ json: { owner: false, incoming: null, outgoing: null } }),
  );
  let overLimit = false;
  await page.route("**/api/drevo/preview", (route) =>
    route.fulfill({
      json: overLimit
        ? {
            token: "over-limit-stage",
            title: "Семейный архив",
            people: 151,
            photos: 3,
            documents: 2,
            comments: 1,
            bytes: 501_000_000,
            canImport: false,
            warning: "Лимит людей: 150; Лимит фотографий и документов: 500 МБ",
          }
        : {
            token: "test-stage",
            title: "Семейный архив",
            people: 12,
            photos: 3,
            documents: 2,
            comments: 1,
            bytes: 2048,
            canImport: true,
            warning: null,
          },
    }),
  );
  await page.goto("/account");
  await expect(page.getByText("Перенести архив в пустое дерево")).toBeVisible();
  await page.getByLabel("Файл .drevo").setInputFiles({
    name: "family.drevo",
    mimeType: "application/zip",
    buffer: Buffer.from("PK"),
  });
  await page.getByRole("button", { name: "Проверить файл" }).click();
  await expect(
    page.locator(".account-portable-preview").getByText("Семейный архив"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Импортировать в это дерево" }),
  ).toBeEnabled();
  overLimit = true;
  await page.getByRole("button", { name: "Проверить файл" }).click();
  await expect(
    page.getByRole("button", { name: "Импортировать в это дерево" }),
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("Лимит людей: 150");
});

test("account cabinet hides archive export from a non-owner", async ({
  page,
}) => {
  await page.route("**/api/account/capacity", (route) =>
    route.fulfill({ json: { available: true, owned: false } }),
  );
  await page.goto("/account");
  await expect(page.getByRole("link", { name: /Скачать дерево/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", { name: /Скачать данные дерева/ }),
  ).toHaveCount(0);
});

test("owner can choose a member and propose a transfer in the account cabinet", async ({
  page,
}) => {
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        local: false,
        user: { ...data.user, fullAccess: true },
      },
    });
  });
  await page.route("**/api/account/capacity", (route) =>
    route.fulfill({
      json: {
        available: true,
        owned: true,
        fullAccess: true,
        people: 12,
        peopleLimit: 150,
        mediaBytes: 1000,
        mediaLimitBytes: 500_000_000,
      },
    }),
  );
  let offered = false;
  await page.route("**/api/account/owner-transfer", (route) => {
    if (route.request().method() === "POST") offered = true;
    return route.fulfill({
      json:
        route.request().method() === "POST"
          ? {
              targetId: "member",
              targetName: "Анна Иванова",
              expiresAt: Date.now() + 1000,
            }
          : {
              owner: true,
              incoming: null,
              outgoing: offered
                ? {
                    targetId: "member",
                    targetName: "Анна Иванова",
                    expiresAt: Date.now() + 1000,
                  }
                : null,
            },
    });
  });
  await page.route("**/api/account/owner-transfer/candidates**", (route) =>
    route.fulfill({
      json: [
        { id: "member", name: "Анна Иванова", role: "reader", eligible: true },
      ],
    }),
  );
  await page.goto("/account");
  await page.getByRole("button", { name: "Передать владение" }).click();
  await page.getByRole("button", { name: "Анна Иванова" }).click();
  await page.getByRole("button", { name: "Предложить передачу" }).click();
  await expect(page.getByText("Ожидаем согласия: Анна Иванова")).toBeVisible();
});

test("deleting a personal tree requires its name and collaborator consent", async ({
  page,
}) => {
  let deleted = false;
  await page.route("**/a/test-archive/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/a/test-archive", "");
    if (path === "/api/session") {
      const response = await route.fetch({
        url: request.url().replace("/a/test-archive", ""),
      });
      const data = await response.json();
      return route.fulfill({
        response,
        json: {
          ...data,
          local: false,
          user: {
            ...data.user,
            role: "admin",
            approved: true,
            fullAccess: true,
          },
        },
      });
    }
    if (path === "/api/account/capacity")
      return route.fulfill({
        json: {
          available: true,
          owned: true,
          fullAccess: true,
          people: 12,
          peopleLimit: 150,
          mediaBytes: 1000,
          mediaLimitBytes: 500_000_000,
        },
      });
    if (path === "/api/account/owner-transfer")
      return route.fulfill({
        json: { owner: true, incoming: null, outgoing: null },
      });
    if (path === "/api/account/archive-deletion") {
      if (request.method() === "DELETE") {
        deleted = true;
        return route.fulfill({ json: { deleted: true, filesRemoved: true } });
      }
      return route.fulfill({
        json: {
          title: "Моё дерево",
          people: 12,
          photos: 3,
          documents: 1,
          otherMembers: 2,
        },
      });
    }
    return route
      .fetch({ url: request.url().replace("/a/test-archive", "") })
      .then((response) => route.fulfill({ response }));
  });
  await page.goto("/a/test-archive/account");
  await page.getByRole("button", { name: "Удалить это дерево" }).click();
  const confirm = page.getByRole("button", { name: "Удалить дерево и файлы" });
  await expect(confirm).toBeDisabled();
  await page
    .getByLabel("Для подтверждения введите название дерева")
    .fill("Моё дерево");
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox").check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect.poll(() => deleted).toBe(true);
  await expect(page).toHaveURL(/\/account$/);
});

test("an account with no tree can create a new private tree", async ({
  page,
}) => {
  let created = false;
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        local: false,
        user: null,
        account: { id: "account-one", name: "Анна", fullAccess: false },
      },
    });
  });
  await page.route("**/api/account/archives", (route) => {
    if (route.request().method() === "POST") {
      created = true;
      return route.fulfill({ status: 201, json: { archiveId: "new-tree" } });
    }
    return route.fulfill({ json: { archives: [] } });
  });
  await page.goto("/account");
  await page.getByRole("button", { name: "Создать новое дерево" }).click();
  await expect.poll(() => created).toBe(true);
  await expect(page).toHaveURL(/\/a\/new-tree\/tree$/);
});

test("account deletion requires its exact name and shared-tree consent", async ({
  page,
}) => {
  let deletionBody: { name: string; leaveSharedArchives: boolean; redactComments: boolean } | null =
    null;
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        local: false,
        user: null,
        account: { id: "account-one", name: "Анна", fullAccess: false },
      },
    });
  });
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({ json: { archives: [] } }),
  );
  await page.route("**/api/account/deletion", async (route) => {
    if (route.request().method() === "DELETE") {
      deletionBody = route.request().postDataJSON();
      return route.fulfill({ json: { deleted: true, sharedArchives: 1 } });
    }
    return route.fulfill({
      json: { name: "Анна", ownedArchives: 0, sharedArchives: 1, canRedactComments: true },
    });
  });
  await page.goto("/account");
  await page.getByRole("button", { name: "Удалить аккаунт" }).click();
  const confirm = page.getByRole("button", { name: "Удалить аккаунт" }).last();
  await expect(confirm).toBeDisabled();
  await page
    .getByRole("textbox", { name: /Для подтверждения введите имя аккаунта/ })
    .fill("Анна");
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox", { name: /теряю доступ/ }).check();
  await page.getByRole("checkbox", { name: /Удалить тексты моих комментариев/ }).check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect
    .poll(() => deletionBody)
    .toEqual({
      name: "Анна",
      leaveSharedArchives: true,
      redactComments: true,
    });
});

test("an invited member can create their own private tree", async ({
  page,
}) => {
  let created = false;
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        local: false,
        user: null,
        account: { id: "account-one", name: "Анна", fullAccess: false },
      },
    });
  });
  await page.route("**/api/account/archives", (route) => {
    if (route.request().method() === "POST") {
      created = true;
      return route.fulfill({ status: 201, json: { archiveId: "new-tree" } });
    }
    return route.fulfill({
      json: {
        archives: [
          {
            id: "shared-tree",
            title: "Дерево родственника",
            role: "reader",
            approved: true,
            owned: false,
            current: false,
          },
        ],
      },
    });
  });
  await page.goto("/account");
  await expect(page.getByText("Дерево родственника")).toBeVisible();
  await page.getByRole("button", { name: "Создать новое дерево" }).click();
  await expect.poll(() => created).toBe(true);
  await expect(page).toHaveURL(/\/a\/new-tree\/tree$/);
});
