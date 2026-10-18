import { test, expect, type Page } from "@playwright/test";

async function mockWorkspace(page: Page) {
  const user = {
    id: "switch-reader",
    name: "Участник",
    role: "reader",
    approved: true,
    archiveOwner: false,
    treeAccess: "all",
    createdAt: "2026-01-01",
  };
  const family = {
    title: "Свое древо",
    description: "",
    demo: false,
    people: [],
    links: [],
    photos: [],
  };
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        user,
        account: { id: user.id, name: user.name },
        local: false,
        canEdit: false,
      },
    }),
  );
  await page.route("**/api/family*", (route) =>
    route.fulfill({
      json: {
        family,
        user,
        local: false,
        canEdit: false,
        readTree: true,
        readPhotos: true,
        revision: 1,
        partial: true,
        pageToken: "1:1:1:switch-reader::all",
        totals: { people: 0, photos: 0 },
      },
    }),
  );
}

test("the primary archive opens its server-provided short address from the switcher and account", async ({ page }) => {
  await mockWorkspace(page);
  await page.route("**/api/account/archives", route => route.fulfill({ json: { archives: [
    { id: "other-tree", title: "Другое древо", current: true, owned: true, approved: true, role: "relative", href: "/a/other-tree/tree" },
    { id: "legacy-primary", title: "Основное древо", current: false, owned: false, approved: true, role: "reader", href: "/tree" },
  ] } }));
  await page.goto("/a/other-tree/tree");
  await page.getByLabel("Меню проекта", { exact: true }).click();
  await page.getByRole("button", { name: "Сменить древо", exact: true }).click();
  const link = page.getByRole("dialog", { name: "Доступные древа" }).getByRole("link", { name: /Основное древо/ });
  await expect(link).toHaveAttribute("href", "/tree");
  await link.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/tree");
  await page.goto("/account");
  await expect(page.getByRole("link", { name: "Открыть древо «Основное древо»" })).toHaveAttribute("href", "/tree");
});

test("menu switches between owned and invited archives without offering pending access", async ({
  page,
}, testInfo) => {
  await mockWorkspace(page);
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({
      json: {
        archives: [
          {
            id: "own-archive",
            title: "Моё древо",
            current: true,
            owned: true,
            approved: true,
            role: "relative",
          },
          {
            id: "invited-archive",
            title: "Древо родственника",
            current: false,
            owned: false,
            approved: true,
            role: "reader",
          },
          {
            id: "pending-archive",
            title: "Ожидающее древо",
            current: false,
            owned: false,
            approved: false,
            role: "reader",
          },
        ],
      },
    }),
  );
  await page.goto("/a/own-archive/tree");
  await page.getByLabel("Меню проекта", { exact: true }).click();
  await page
    .getByRole("button", { name: "Сменить древо", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Доступные древа" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Ваше древо", { exact: true })).toBeVisible();
  const link = dialog.getByRole("link", { name: /Древо родственника/ });
  await expect(link).toHaveAttribute("href", "/a/invited-archive/tree");
  await expect(dialog.getByText("Ожидает доступа")).toBeVisible();
  await expect(dialog.getByRole("link")).toHaveCount(1);
  await expect(link).toContainText("Читатель");
  await expect(dialog.locator('[aria-current="true"]')).toContainText(
    "Моё древо",
  );
  await dialog.screenshot({
    path: testInfo.outputPath("archive-switcher.png"),
  });
  await page.screenshot({
    path: testInfo.outputPath("archive-switcher-page.png"),
  });
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await expect(link).toHaveCSS("outline-style", "solid");
  const row = (await link.boundingBox())!;
  expect(row.width).toBeGreaterThan(200);
  expect(row.height).toBeGreaterThanOrEqual(44);
  const newTab = page.context().waitForEvent("page");
  await link.click({ button: "middle" });
  const opened = await newTab;
  await opened.waitForLoadState("domcontentloaded");
  expect(new URL(opened.url()).pathname).toBe("/a/invited-archive/tree");
  expect(new URL(page.url()).pathname).toBe("/a/own-archive/tree");
  await opened.close();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Меню проекта", { exact: true })).toBeFocused();
});

test("switcher searches many trees and contains long names at narrow widths", async ({
  page,
  isMobile,
}, info) => {
  await mockWorkspace(page);
  const longTitle =
    "Родословная семьи Александровых и их родственников из нескольких поколений";
  const archives = [
    {
      id: "own-archive",
      title: "Моё древо",
      owned: true,
      current: true,
      approved: true,
      role: "relative",
    },
    {
      id: "long-title",
      title: longTitle,
      owned: false,
      current: false,
      approved: true,
      role: "relative",
    },
    {
      id: "long-word",
      title:
        "НевероятноДлинноеНазваниеСемейногоДреваБезПробеловДляПроверкиПереноса",
      owned: false,
      current: false,
      approved: true,
      role: "reader",
    },
    ...[
      "Материнская линия",
      "Семья Петровых",
      "Отцовская линия",
      "Семья Сидоровых",
      "Семья Ивановых",
    ].map((title, index) => ({
      id: `invited-${index}`,
      title,
      owned: false,
      current: false,
      approved: true,
      role: "reader",
    })),
  ];
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({ json: { archives } }),
  );
  await page.goto("/a/own-archive/tree");
  await page.getByLabel("Меню проекта", { exact: true }).click();
  await page
    .getByRole("button", { name: "Сменить древо", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Доступные древа" });
  const search = dialog.getByRole("textbox", { name: "Найти древо" });
  await expect(search).toBeVisible();
  for (const width of isMobile ? [320, 390] : [768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    if (width === 320) {
      const title = dialog
        .locator(".archive-switcher-name strong")
        .filter({ hasText: longTitle });
      expect((await title.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    }
    await dialog.screenshot({
      path: info.outputPath(`archive-switcher-many-${width}.png`),
    });
    await page.screenshot({
      path: info.outputPath(`archive-switcher-many-page-${width}.png`),
    });
  }
  const longLink = dialog.getByRole("link", { name: new RegExp(longTitle) });
  await expect(longLink).toHaveAttribute("title", longTitle);
  await search.fill("АЛЕКСАНДРОВЫХ");
  await expect(dialog.getByRole("link")).toHaveCount(1);
  await expect(longLink).toBeVisible();
  await search.fill("Несуществующее древо");
  await expect(dialog.getByRole("status")).toHaveText("Древа не найдены.");
  await expect(dialog.getByRole("link")).toHaveCount(0);
  await search.fill("");
  await expect(dialog.getByRole("link")).toHaveCount(archives.length - 1);
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("switcher keeps loading, error retry and empty states compact", async ({
  page,
}, info) => {
  await mockWorkspace(page);
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route("**/api/account/archives", async (route) => {
    attempts++;
    if (attempts === 1) {
      await pending;
      return route.fulfill({ status: 503, json: { error: "Temporary" } });
    }
    return route.fulfill({ json: { archives: [] } });
  });
  await page.goto("/a/own-archive/tree");
  await page.getByLabel("Меню проекта", { exact: true }).click();
  await page
    .getByRole("button", { name: "Сменить древо", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Доступные древа" });
  await expect(dialog.getByRole("status")).toHaveText("Загружаем древа…");
  expect((await dialog.boundingBox())!.height).toBeLessThan(220);
  release();
  await expect(dialog.getByRole("alert")).toContainText(
    "Не удалось загрузить древа.",
  );
  await dialog.screenshot({
    path: info.outputPath("archive-switcher-error.png"),
  });
  await dialog.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Пока нет доступных древ.",
  );
  expect((await dialog.boundingBox())!.height).toBeLessThan(220);
  expect(attempts).toBe(2);
});
