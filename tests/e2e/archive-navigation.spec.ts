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

test("the avatar opens the compact menu without replacing archive tabs", async ({
  page,
}, testInfo) => {
  await page.goto("/tree");
  const menu = page.locator(".archive-more");
  const avatar = menu.locator("summary");
  const account = menu.getByRole("link", { name: "Личный кабинет" });
  const about = page.getByRole("button", { name: "О проекте", exact: true });
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute("aria-label", "Меню проекта");
  await expect(avatar.locator(".nav-account-avatar")).toHaveText("Н");
  await expect(page.locator(".archive-nav > .nav-admin, .archive-nav > .nav-account")).toHaveCount(0);
  if (testInfo.project.name === "desktop") {
    await expect(page.locator(".nav-sections")).toBeVisible();
    await expect(page.locator(".nav-about")).toBeVisible();
  } else {
    await expect(page.locator(".nav-sections")).toBeHidden();
    await expect(page.locator(".nav-about")).toBeHidden();
  }

  await avatar.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveAttribute("open");
  await expect(account).toHaveAttribute("href", "/account");
  await expect(account).toBeVisible();
  const bounds = (await menu.locator(".nav-bottom").boundingBox())!;
  expect(bounds.width).toBeLessThanOrEqual(280);
  await page.keyboard.press("Tab");
  await expect(account).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open");
  await expect(avatar).toBeFocused();
  await avatar.click();
  await page.locator(".archive-search").click();
  await expect(menu).not.toHaveAttribute("open");

  if (testInfo.project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 640 });
    await avatar.click();
    await expect(about).toBeVisible();
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("avatar-menu-mobile-320.png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 844, height: 390 });
    await avatar.click();
    const landscape = (await menu.locator(".nav-bottom").boundingBox())!;
    expect(landscape.y + landscape.height).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("avatar-menu-landscape.png") });
  } else {
    await page.setViewportSize({ width: 1280, height: 720 });
    await avatar.click();
    await expect(page.locator(".nav-sections")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("avatar-menu-desktop.png") });
  }
  await account.click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(menu).not.toHaveAttribute("open");
  await avatar.click();
  await expect(menu.getByRole("link", { name: "Личный кабинет" })).toHaveAttribute("aria-current", "page");
  await expect(menu.getByRole("link", { name: "Поиск опубликованных людей" })).toHaveAttribute("href", "/discover");
  if (testInfo.project.name === "mobile") {
    await menu.getByRole("button", { name: "О проекте" }).click();
    await expect(page.getByRole("dialog", { name: "О проекте" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(avatar).toBeFocused();
  }
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
  const originalImage = await image.elementHandle();
  await page.getByLabel("Меню проекта").click();
  await page.locator(".nav-menu-account").click();
  await expect(page).toHaveURL(/\/account$/);
  expect(await originalImage!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(image).toHaveAttribute("src", "/media/nav-avatar.jpg?variant=thumb");
});

test("a failed portrait falls back to the account initial without hiding the menu", async ({ page }) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = "e2e-memorial-person";
    data.family.people.find(
      (person: { id: string }) => person.id === data.user.personId,
    ).photo = "/media/missing-nav-avatar.jpg";
    await route.fulfill({ response, json: data });
  });
  await page.route("**/media/missing-nav-avatar.jpg?variant=thumb", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.goto("/tree");
  const avatar = page.locator(".nav-account");
  await expect(avatar.locator(".nav-account-avatar")).toHaveText("Н");
  await expect(avatar.locator("img")).toHaveCount(0);
  await avatar.click();
  await expect(page.locator(".nav-menu-account")).toBeVisible();
});

test("a guest can reach sign-in and public discovery from the avatar menu", async ({
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
    "Меню проекта",
  );
  await page.locator(".nav-account").click();
  await expect(page.locator(".nav-menu-account")).toHaveAttribute("href", "/account");
  await expect(page.locator(".nav-bottom").getByRole("button", { name: "Выйти" })).toHaveCount(0);
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
    page.locator(".nav-bottom").getByRole("link", { name: "Поиск опубликованных людей" }),
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
    page.getByRole("link", { name: /Скачать древо с фото и документами/ }),
  ).toHaveAttribute("href", "/api/gedcom/export?format=gedzip7");
  await expect(
    page.getByRole("link", { name: /Скачать данные древа/ }),
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
        emptyArchive: true,
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
  let unsupported = false;
  await page.route("**/api/drevo/preview", (route) =>
    route.fulfill(unsupported ? {
      status: 400,
      json: { error: "Пакет Drevo содержит неподдерживаемые поля в разделе archive.json; обновите Drevo" },
    } : {
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
  await expect(page.getByText("Перенести архив в пустое древо")).toBeVisible();
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
    page.getByRole("button", { name: "Импортировать в это древо" }),
  ).toBeEnabled();
  overLimit = true;
  await page.getByRole("button", { name: "Проверить файл" }).click();
  await expect(
    page.getByRole("button", { name: "Импортировать в это древо" }),
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("Лимит людей: 150");
  unsupported = true;
  await page.getByRole("button", { name: "Проверить файл" }).click();
  await expect(page.getByRole("alert")).toContainText("неподдерживаемые поля");
  await expect(page.getByRole("button", { name: "Импортировать в это древо" })).toHaveCount(0);
});

test("account cabinet hides archive export from a non-owner", async ({
  page,
}) => {
  await page.route("**/api/account/capacity", (route) =>
    route.fulfill({ json: { available: true, owned: false } }),
  );
  await page.goto("/account");
  await expect(page.getByRole("link", { name: /Скачать древо/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", { name: /Скачать данные древа/ }),
  ).toHaveCount(0);
});

test("owner is not offered portable import when only catalog data occupies the archive", async ({ page }) => {
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: {
      ...data, local: false, user: { ...data.user, fullAccess: false },
    } });
  });
  await page.route("**/api/account/capacity", (route) => route.fulfill({ json: {
    available: true, owned: true, fullAccess: false, people: 0,
    emptyArchive: false, peopleLimit: 150, mediaBytes: 0,
    mediaLimitBytes: 500_000_000,
  } }));
  await page.goto("/account");
  await expect(page.getByText("Перенести архив в пустое древо")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Скачать полный переносимый архив/ })).toBeVisible();
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
        {
          id: "limited",
          name: "Борис Иванов",
          role: "reader",
          eligible: false,
          reason: "unavailable",
        },
      ],
    }),
  );
  await page.goto("/account");
  await page.getByRole("button", { name: "Передать владение" }).click();
  await expect(page.getByRole("button", { name: "Борис Иванов" })).toBeDisabled();
  await expect(page.getByText(/сейчас не может принять древо/)).toBeVisible();
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
  await page.getByRole("button", { name: "Удалить это древо" }).click();
  const confirm = page.getByRole("button", { name: "Удалить древо и файлы" });
  await expect(confirm).toBeDisabled();
  await page
    .getByLabel("Для подтверждения введите название древа")
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
  await page.getByRole("button", { name: "Создать новое древо" }).click();
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
  await page.getByRole("button", { name: "Создать новое древо" }).click();
  await expect.poll(() => created).toBe(true);
  await expect(page).toHaveURL(/\/a\/new-tree\/tree$/);
});
