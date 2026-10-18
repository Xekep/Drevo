import { expect, test, type Page } from "@playwright/test";

const name = "Александра Константиновна Петрова";
async function identity(page: Page, member = true) {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        user: member
          ? {
              id: "owner",
              name,
              role: "admin",
              treeRole: "relative",
              archiveOwner: true,
              approved: true,
              platformAdmin: true,
              fullAccess: true,
            }
          : null,
        account: {
          id: "owner",
          name,
          globalRole: "admin",
          fullAccess: true,
          provider: "email",
          createdAt: "2026-01-01",
        },
        local: false,
        email: true,
        yandex: false,
        vk: false,
      },
    }),
  );
  await page.route("**/api/account/sessions", (route) =>
    route.fulfill({ json: { otherCount: 0, currentExpiresAt: null } }),
  );
  await page.route("**/api/account/capacity", (route) =>
    route.fulfill({
      json: {
        available: true,
        owned: true,
        fullAccess: true,
        people: 6,
        emptyArchive: false,
        peopleLimit: 100,
        mediaBytes: 0,
        mediaLimitBytes: 500_000_000,
      },
    }),
  );
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({
      json: {
        archives: [
          {
            id: "primary", href: "/a/primary/tree",
            title: "Древо Петровых",
            role: "relative",
            approved: true,
            owned: true,
            current: true,
          },
        ],
      },
    }),
  );
  await page.route("**/api/platform/accounts", (route) =>
    route.fulfill({
      json: {
        accounts: [
          {
            id: "member",
            name,
            role: "researcher",
            fullAccess: true,
            lastVisitAt: null,
          },
        ],
        next: null,
      },
    }),
  );
  await page.route("**/api/users?**", (route) =>
    route.fulfill({
      json: {
        users: [
          {
            id: "member",
            name,
            role: "reader",
            treeRole: "reader",
            approved: true,
            personId: "e2e-child",
            treeAccess: "common_ancestors",
          },
        ],
        next: null,
        total: 1,
      },
    }),
  );
}

for (const section of ["storage", "vk", "backups", "resources"] as const) {
  test(`platform ${section} preserves a rejected draft and discards only after explicit consent`, async ({
    page,
  }) => {
    await identity(page, false);
    await page.route("**/api/settings/storage", (route) =>
      route.fulfill({
        json: { admin: 100, researcher: 50, relative: 10, reader: 0 },
      }),
    );
    await page.route("**/api/admin/auth/vk", (route) =>
      route.fulfill({
        json: {
          enabled: false,
          clientId: "12345",
          available: false,
          callbackUrl: "",
        },
      }),
    );
    await page.route("**/api/platform/backups**", (route) =>
      route.fulfill({
        json: {
          settings: {
            enabled: false,
            intervalHours: 24,
            keepCount: 7,
            storage: "local",
            remoteHost: "",
            remoteDirectory: "",
          },
          nextRunAt: null,
          localDirectory: "/test",
          sshConfig: "",
          records: [],
          total: 0,
          job: null,
        },
      }),
    );
    await page.route("**/api/admin/research-resources", (route) =>
      route.fulfill({ json: { categories: [] } }),
    );
    await page.goto(`/admin?section=${section}`);
    if (section === "resources")
      await page.getByText("Добавить категорию", { exact: true }).click();
    const field = page.getByLabel(
      section === "storage"
        ? "Лимит: Администратор"
        : section === "vk"
          ? "ID приложения"
          : section === "backups"
            ? "Количество копий"
            : "Новая категория",
      { exact: section !== "backups" },
    );
    await field.fill(
      section === "resources" ? "Несохранённая категория" : "321",
    );
    const navigation = page.getByRole("navigation", {
      name: "Разделы админки платформы",
    });
    let prompts = 0;
    page.once("dialog", async (dialog) => {
      prompts++;
      await dialog.dismiss();
    });
    await navigation
      .getByRole("link", { name: "Пользователи", exact: true })
      .click();
    await expect(field).toHaveValue(
      section === "resources" ? "Несохранённая категория" : "321",
    );
    await expect(page).toHaveURL(new RegExp(`section=${section}$`));
    page.once("dialog", async (dialog) => {
      prompts++;
      await dialog.accept();
    });
    await navigation
      .getByRole("link", { name: "Пользователи", exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin$/);
    expect(prompts).toBe(2);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`section=${section}$`));
    if (section === "resources")
      await page.getByText("Добавить категорию", { exact: true }).click();
    await expect(field).not.toHaveValue("321");
    await expect(field).not.toHaveValue("Несохранённая категория");
  });
}

test("public access protects Back, then discards the abandoned draft and restores the selected section", async ({
  page,
}) => {
  await identity(page);
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: { publicTree: false, publicAlbums: false, reverseTimeline: false },
    }),
  );
  await page.goto("/manage");
  const navigation = page.getByRole("navigation", {
    name: "Разделы админки",
    exact: true,
  });
  await navigation
    .getByRole("link", { name: "Общий доступ", exact: true })
    .click();
  await page.getByLabel("Всё древо по ссылке").check();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(/section=shares$/);
  await expect(page.getByLabel("Всё древо по ссылке")).toBeChecked();
  page.once("dialog", (dialog) => dialog.accept());
  await page.goBack();
  await expect(
    navigation.getByRole("link", { name: "Участники", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await navigation
    .getByRole("link", { name: "Общий доступ", exact: true })
    .click();
  await expect(page.getByLabel("Всё древо по ссылке")).not.toBeChecked();
  await page.reload();
  await expect(
    navigation.getByRole("link", { name: "Общий доступ", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("settings failure is visible beside usable participants and can be retried", async ({
  page,
}) => {
  await identity(page);
  let fail = true;
  await page.route("**/api/settings", (route) =>
    route.fulfill(
      fail
        ? { status: 503, json: { error: "Настройки временно недоступны" } }
        : {
            json: {
              publicTree: false,
              publicAlbums: false,
              reverseTimeline: false,
            },
          },
    ),
  );
  await page.goto("/manage");
  await expect(
    page.getByRole("article", { name: `Участник: ${name}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Настройки временно недоступны",
  );
  fail = false;
  await page
    .getByRole("button", { name: "Повторить загрузку настроек" })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("account can retry the tree directory and keeps a failed logout on screen", async ({
  page,
}) => {
  await identity(page, false);
  let fail = true;
  await page.route("**/api/account/archives", (route) =>
    route.fulfill(
      fail
        ? { status: 503, json: { error: "Unavailable" } }
        : {
            json: {
              archives: [
                {
                  id: "other", href: "/a/other/tree",
                  title: "Архив Ивановых",
                  role: "reader",
                  approved: true,
                  owned: false,
                  current: false,
                },
              ],
            },
          },
    ),
  );
  await page.route("**/auth/logout", (route) =>
    route.fulfill({ status: 503, json: { error: "Unavailable" } }),
  );
  await page.goto("/account");
  await expect(page.getByRole("alert")).toContainText(
    "Не удалось загрузить древа",
  );
  fail = false;
  await page.getByRole("button", { name: "Повторить загрузку древ" }).click();
  await expect(
    page.getByRole("link", { name: "Открыть древо «Архив Ивановых»" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Выйти из этого сеанса", exact: true })
    .click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("alert")).toContainText("Не удалось выйти");
  await page
    .getByRole("button", { name: "Сменить пароль", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page
      .getByLabel("Новый пароль", { exact: true })
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(16);
});

test("section links survive refresh, browser history and opening a new tab", async ({
  page,
}) => {
  await identity(page, false);
  await page.route("**/api/settings/storage", (route) =>
    route.fulfill({
      json: { admin: 100, researcher: 50, relative: 10, reader: 0 },
    }),
  );
  await page.goto("/admin");
  const navigation = page.getByRole("navigation", {
    name: "Разделы админки платформы",
  });
  const storage = navigation.getByRole("link", {
    name: "Хранилище",
    exact: true,
  });
  const newPage = page.context().waitForEvent("page");
  await page.bringToFront();
  await storage.click({ modifiers: ["ControlOrMeta"] });
  const opened = await newPage;
  await expect(opened).toHaveURL(/\/admin\?section=storage$/);
  await opened.close();
  await page.bringToFront();
  await storage.click();
  await expect(page).toHaveURL(/section=storage$/);
  await page.reload();
  await expect(storage).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveTitle(/Хранилище · Админка/);
  await page.goBack();
  await expect(
    navigation.getByRole("link", { name: "Пользователи", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("statistics fits the actual 320px container and long participant names stay readable", async ({
  page,
}) => {
  await identity(page);
  await page.goto("/admin");
  await page.setViewportSize({ width: 320, height: 900 });
  const statistics = await page
    .getByRole("button", { name: "Статистика", exact: true })
    .boundingBox();
  expect(statistics).not.toBeNull();
  expect(statistics!.x + statistics!.width).toBeLessThanOrEqual(320);
  expect(
    await page
      .locator("main")
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/manage");
  const fullName = page.locator(".admin-user-identity b");
  await expect(fullName).toHaveText(name);
  expect(
    await fullName.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await expect(
    page.getByRole("combobox", { name: `Доступ к древу: ${name}` }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("manage-1440.png") });
  await page.goto("/account");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Мои древа", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".account-selected-tree")
      .getByRole("link", { name: "Управление древом", exact: true }),
  ).toHaveCount(1);
  expect(
    await page
      .getByRole("heading", { name: "Мои древа", exact: true })
      .evaluate((element) => element.getBoundingClientRect().top),
  ).toBeLessThan(600);
  await page.screenshot({ path: test.info().outputPath("account-390.png") });
});

test("journal authors are independent of the participant page and preserve selection across author pages", async ({
  page,
}) => {
  await identity(page);
  await page.route("**/api/audit/actors?**", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).searchParams.get("before") === "0"
          ? { actors: [{ id: "former", name: "Бывший участник" }], next: 10 }
          : {
              actors: [{ id: "older", name: "Автор старых правок" }],
              next: null,
            },
    }),
  );
  const filters: string[] = [];
  await page.route(/\/api\/audit\?/, (route) => {
    filters.push(
      new URL(route.request().url()).searchParams.get("actorId") || "",
    );
    return route.fulfill({ json: { items: [], next: null } });
  });
  await page.goto("/manage?section=audit");
  await page.getByLabel("Кто изменил", { exact: true }).selectOption("former");
  await expect.poll(() => filters).toContain("former");
  await page.getByRole("button", { name: "Другие авторы" }).click();
  await expect(
    page.getByRole("option", { name: "Автор старых правок" }),
  ).toHaveCount(1);
  await expect(page.getByLabel("Кто изменил", { exact: true })).toHaveValue(
    "former",
  );
});
