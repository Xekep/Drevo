import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import type { ArchiveUser } from "../../src/domain/access.ts";
import type { Family, Person } from "../../src/domain/types.ts";
import { projectFamilyForUser } from "../../src/domain/tree-access.ts";

const prefix = "/a/preview-archive/preview/member%3Atest";
const person = (id: string, name: string, parents: string[] = []): Person => ({
  id,
  name,
  surname: "Тестов",
  patronymic: "",
  sex: "m",
  birth: "1970",
  birthPlace: "",
  parents,
  spouses: [],
  sources: [],
  generation: parents.length ? 2 : 1,
  column: 0,
  photo: id === "child" ? "/media/member-linked-portrait.png" : "/media/preview-portrait.png",
});
const member: ArchiveUser = {
  id: "member:test",
  name: "Участник предпросмотра",
  role: "relative",
  treeRole: "relative",
  globalRole: null,
  archiveOwner: false,
  approved: true,
  createdAt: "2026-10-05",
  personId: "child",
  treeAccess: "common_ancestors",
};
const owner: ArchiveUser = {
  ...member,
  id: "owner",
  name: "Владелец",
  role: "relative",
  archiveOwner: true,
  personId: "hidden",
  treeAccess: "all",
};
const fullFamily: Family = {
  title: "Предпросмотр участника",
  description: "",
  demo: false,
  people: [
    person("parent", "Иван"),
    person("child", "Пётр", ["parent"]),
    { ...person("own-person", "Отдельный"), createdBy: member.id },
    person("hidden", "Скрытый"),
    person("union-partner", "Партнёр", ["hidden"]),
  ],
  unions: [{ id: "partner-union", type: "partnership", participants: ["child", "union-partner"] }],
  photos: [
    {
      id: "preview-photo",
      title: "Фото участника",
      url: "/media/preview-photo.png",
      createdBy: member.id,
      tags: [
        {
          id: "tag",
          personId: "child",
          x: 0.1,
          y: 0.1,
          width: 0.3,
          height: 0.3,
        },
      ],
    },
  ],
  links: [],
};
const family = projectFamilyForUser(fullFamily, member);
const documentId = "11111111-1111-4111-8111-111111111111";
const entry = {
  id: documentId,
  title: "Скан участника",
  url: `/api/documents/${documentId}/file`,
  size: 100,
  mimeType: "image/png",
  createdAt: "2026-10-05",
  canDelete: false,
  people: [{ id: "child", name: "Тестов Пётр" }],
  eventLinks: [],
  pages: [],
  sources: [],
  documentType: "",
  documentDate: "",
  place: "",
  description: "",
  provenance: "",
};

async function mockPreview(
  page: Page,
  denied = false,
  expectedPrefix = prefix,
  initial: { approved?: boolean; reverseTimeline?: boolean } = {},
) {
  const requests: Array<{ path: string; method: string }> = [];
  const unscoped: string[] = [];
  const image = await sharp({
    create: {
      width: 360,
      height: 480,
      channels: 3,
      background: "#aabfa0",
    },
  })
    .png()
    .toBuffer();
  await page.route(/\/(?:api|media)\//, async (route) => {
    const url = new URL(route.request().url());
    requests.push({ path: url.pathname, method: route.request().method() });
    if (!url.pathname.startsWith(`${expectedPrefix}/`)) {
      unscoped.push(url.pathname);
      return route.fulfill({
        status: 403,
        json: { error: "Владельческий API недоступен в предпросмотре" },
      });
    }
    const path = url.pathname.slice(expectedPrefix.length);
    if (denied)
      return route.fulfill({
        status: 403,
        json: { error: "Просмотр недоступен" },
      });
    if (path === "/api/session")
      return route.fulfill({
        json: {
          user: { ...member, approved: initial.approved ?? member.approved },
          account: null,
          local: false,
          preview: true,
        },
      });
    if (path === "/api/family")
      return route.fulfill({
        json: {
          family,
          user: { ...member, approved: initial.approved ?? member.approved },
          revision: 1,
          canEdit: false,
          local: false,
          readTree: true,
          readPhotos: true,
          treePreferences: { reverseTimeline: initial.reverseTimeline },
          participantPreview: {
            id: member.id,
            name: member.name,
          },
        },
      });
    if (
      path.startsWith("/media/") ||
      path === `/api/documents/${documentId}/file`
    )
      return route.fulfill({ contentType: "image/png", body: image });
    if (path === "/api/documents")
      return route.fulfill({ json: { items: [entry], total: 1 } });
    if (path === `/api/documents/${documentId}`)
      return route.fulfill({ json: entry });
    if (path.endsWith("/annotations"))
      return route.fulfill({ json: { items: [], total: 0 } });
    if (path.endsWith("/discussion"))
      return route.fulfill({
        json: {
          items: [
            {
              id: 1,
              text: "Обсуждение, доступное участнику",
              author: "Автор",
              authorPersonId: null,
              createdAt: "2026-10-05",
              editedAt: null,
              canEdit: false,
              canDelete: false,
              attachments: [
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  name: "Фото обсуждения.png",
                  type: "image/png",
                  size: image.length,
                  url: "/media/discussion-photo.png",
                  previewUrl: "/media/discussion-photo.png",
                },
              ],
            },
          ],
          nextBefore: null,
          total: 1,
        },
      });
    if (path === "/api/research-resources")
      return route.fulfill({ json: { categories: [] } });
    if (path === "/api/people/search")
      return route.fulfill({
        json: { items: family.people, total: family.people.length },
      });
    return route.fulfill({ json: { items: [], total: 0 } });
  });
  return { requests, unscoped };
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("member preview exposes view settings without writing either account or guest preferences", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem(
    "drevo:guest-tree-preferences:v1", JSON.stringify({ reverseTimeline: true, colorScheme: "white" }),
  ));
  const { requests, unscoped } = await mockPreview(page, false, prefix, { reverseTimeline: true });
  await page.goto(`${prefix}/tree`);
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/theme-white/);
  await expect.poll(async () => {
    const parent = await page.locator('.flow-person[data-person-id="parent"]').first().boundingBox();
    const child = await page.locator('.flow-person[data-person-id="child"]').first().boundingBox();
    return !!parent && !!child && parent.y < child.y;
  }).toBe(true);
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await expect(dialog.getByRole("radio", { name: "Предки сверху" })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Управление древом" })).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Белая" }).check();
  await expect(canvas).toHaveClass(/theme-white/);
  await dialog.getByRole("radio", { name: "Потомки сверху" }).check();
  await expect(dialog.getByRole("radio", { name: "Потомки сверху" })).toBeChecked();
  await dialog.getByRole("button", { name: "Сбросить вид" }).click();
  await expect(dialog.getByRole("radio", { name: "Предки сверху" })).toBeChecked();
  await expect(canvas).not.toHaveClass(/theme-white/);
  const wheelHint = dialog.getByText("Нажмите колесо мыши на карточке, чтобы выбрать опорного человека.");
  if (info.project.name === "mobile") await expect(wheelHint).toBeHidden();
  else await expect(wheelHint).toBeVisible();
  await dialog.getByRole("switch", { name: "Ограничить видимое древо" }).check();
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  const anchor = page.getByRole("status", { name: "Опорный человек" });
  await expect(anchor).toBeVisible();
  const viewport = page.locator(".react-flow__viewport");
  const mountedViewport = await viewport.elementHandle();
  if (info.project.name === "desktop") {
    await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
    await page.locator('.flow-person[data-person-id="parent"]').first().click({ button: "middle" });
    await expect(anchor).toContainText("Опорный: Тестов Иван");
    await expect(page.getByRole("tablist", { name: "Сведения о человеке" })).toHaveCount(0);
  }
  await anchor.getByRole("button", { name: "Снять ограничения поколений", exact: true }).click();
  await expect(anchor).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-layout-people", "4");
  expect(await mountedViewport!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("drevo:guest-tree-preferences:v1")!)))
    .toEqual({ reverseTimeline: true, colorScheme: "white" });
  await page.reload();
  await expect(page.locator('.flow-person[data-person-id="child"] .portrait-card-info small').first())
    .toHaveText("Это вы");
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await expect(dialog.getByRole("radio", { name: "Предки сверху" })).toBeChecked();
  await expect(dialog.locator(".member-preview-banner")).toContainText(member.name);
  await expect(dialog.getByRole("link", { name: "Выйти из просмотра" })).toBeVisible();
  // Clicking padding within the dialog is not a backdrop dismissal.
  await dialog.locator("h2").click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  expect(unscoped).toEqual([]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

test("public preview for a pending participant ignores inverted guest settings", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem(
    "drevo:guest-tree-preferences:v1", JSON.stringify({ reverseTimeline: true, colorScheme: "white" }),
  ));
  const { requests } = await mockPreview(page, false, prefix, { approved: false });
  await page.goto(`${prefix}/tree`);
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling|theme-white/);
  await expect.poll(async () => {
    const parent = await page.locator('.flow-person[data-person-id="parent"]').first().boundingBox();
    const child = await page.locator('.flow-person[data-person-id="child"]').first().boundingBox();
    return !!parent && !!child && parent.y < child.y;
  }).toBe(true);
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await expect(dialog.getByRole("radio", { name: "Предки сверху" })).toBeChecked();
  await dialog.getByRole("radio", { name: "Потомки сверху" }).check();
  await expect(dialog.getByRole("radio", { name: "Потомки сверху" })).toBeChecked();
  await page.reload();
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await expect(dialog.getByRole("radio", { name: "Предки сверху" })).toBeChecked();
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("drevo:guest-tree-preferences:v1")!)))
    .toEqual({ reverseTimeline: true, colorScheme: "white" });
});

test("preview avatar opens a populated scoped menu with the participant portrait", async ({ page }, info) => {
  const { requests, unscoped } = await mockPreview(page);
  await page.goto(`${prefix}/tree`);
  const trigger = page.getByLabel("Разделы предпросмотра", { exact: true });
  await expect(trigger.locator("img")).toHaveAttribute("src", `${prefix}/media/member-linked-portrait.png?variant=thumb`);
  await trigger.click();
  const menu = page.locator(".archive-more .nav-bottom");
  await expect(menu.getByRole("link", { name: "Фото", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Вид древа", exact: true })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Выйти из просмотра", exact: true }))
    .toHaveAttribute("href", "/a/preview-archive/manage");
  await expect(menu.getByRole("link", { name: "Управление древом" })).toHaveCount(0);
  await expect(menu.getByRole("link", { name: "Админка платформы" })).toHaveCount(0);
  await expect(menu.getByRole("link", { name: "Личный кабинет" })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("preview-menu.png") });
  await menu.getByRole("link", { name: "Фото", exact: true }).click();
  await expect(page).toHaveURL(`${prefix}/photos`);
  await expect(page.locator(".archive-more")).not.toHaveAttribute("open", "");
  await trigger.click();
  await menu.getByRole("button", { name: "Вид древа" }).click();
  await expect(page.getByRole("dialog", { name: "Вид древа" })).toBeVisible();
  expect(unscoped).toEqual([]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

test("mobile tree fullscreen retains the participant banner and a reachable exit", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Fullscreen canvas control is mobile-only");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { requests, unscoped } = await mockPreview(page);
  await page.goto(`${prefix}/tree`);
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await page.getByRole("button", { name: "Развернуть на весь экран" }).click();
  await expect(canvas).toHaveClass(/is-fullscreen/);
  const banner = canvas.locator(".member-preview-banner");
  await expect(banner).toContainText(member.name);
  const exit = banner.getByRole("link", { name: "Выйти из просмотра", exact: true });
  await exit.click({ trial: true });
  expect((await banner.boundingBox())!.y).toBeLessThanOrEqual(1);
  // Chromium supports native fullscreen; the banner belongs to that subtree.
  expect(await banner.evaluate((element) =>
    !document.fullscreenElement || document.fullscreenElement.contains(element))).toBe(true);
  expect(unscoped).toEqual([]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

test("preview exit stays available while restored-session access is being checked", async ({ page }) => {
  await mockPreview(page);
  await page.goto(`${prefix}/tree`);
  await expect(page.locator(".tree-canvas")).toHaveAttribute("data-layout-ready", "true");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/session", async (route) => {
    await pending;
    await route.fulfill({ json: { user: member, account: null, local: false, preview: true } });
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    const gate = page.getByRole("dialog", { name: "Проверка доступа" });
    await expect(gate).toBeVisible();
    await expect(gate.locator(".member-preview-banner")).toContainText(member.name);
    await gate.getByRole("link", { name: "Выйти из просмотра", exact: true }).click({ trial: true });
  } finally {
    release();
  }
  await expect(page.getByRole("dialog", { name: "Проверка доступа" })).toHaveCount(0);
});

test("member preview keeps all archive sections and deep links in the member scope", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "drevo_pending_invite",
      "/join/other-archive/" + "a".repeat(43),
    );
  });
  const { requests, unscoped } = await mockPreview(page);
  for (const [path, heading] of [
    ["tree", null],
    ["people", "Люди"],
    ["families", "Семьи"],
    ["photos", "Семейный альбом"],
    ["documents", "Документы"],
    ["places", "Места, которые нас связывают"],
    ["insights", "Сводка архива"],
    ["resources", "Ресурсы поиска"],
  ] as const) {
    await page.goto(`${prefix}/${path}`);
    const exit = page.getByRole("link", {
      name: "Выйти из просмотра",
      exact: true,
    });
    await expect(exit).toBeVisible();
    await expect(exit).toHaveAttribute("href", "/a/preview-archive/manage");
    const exitBox = await exit.boundingBox();
    expect(exitBox!.x + exitBox!.width).toBeGreaterThan(
      page.viewportSize()!.width * 0.8,
    );
    if (heading)
      await expect(
        page.getByRole("heading", { name: new RegExp(`^${heading}(?:\\s|$)`) }),
      ).toBeVisible();
    else {
      await expect(
        page
          .locator(
            '.flow-person[data-person-id="child"] .portrait-card-info small',
          )
          .first(),
      ).toHaveText("Это вы");
      await expect(
        page
          .locator(
            '.flow-person[data-person-id="parent"] .portrait-card-info small',
          )
          .first(),
      ).toHaveText("Отец");
      await expect(
        page.locator('.flow-person[data-person-id="own-person"]').first(),
      ).toBeVisible();
      await expect(page.locator('.flow-person[data-person-id="union-partner"]').first()).toBeVisible();
      await expect(
        page.locator('.flow-person[data-person-id="hidden"]'),
      ).toHaveCount(0);
      await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
      await page.screenshot({ path: info.outputPath("member-preview.png") });
    }
    const nav = page.getByRole("navigation", { name: "Разделы архива" });
    const archiveLinks = await nav
      .locator(".nav-sections a, .mobile-sections a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(archiveLinks.length).toBeGreaterThanOrEqual(8);
    expect(archiveLinks.every((href) => href?.startsWith(`${prefix}/`))).toBe(
      true,
    );
    await expect(
      page.getByRole("link", { name: "Личный кабинет", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Управление древом", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Добавить документ", exact: true }),
    ).toHaveCount(0);
  }
  expect(unscoped).toEqual([]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

test("profile discussion and document reader use preview requests without editing the participant", async ({
  page,
}) => {
  const { requests, unscoped } = await mockPreview(page);
  await page.goto(`${prefix}/people/child`);
  await expect(
    page.getByRole("button", { name: "Изменить человека", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: /Обсуждение/ }).click();
  await expect(
    page.getByText("Обсуждение, доступное участнику", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", {
      name: "Сообщение для обсуждения",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.goto(`${prefix}/documents/${documentId}`);
  const reader = page.getByRole("dialog", { name: "Документ: Скан участника" });
  await expect(reader).toBeVisible();
  const book = reader.frameLocator("iframe.pdf-book-frame");
  const image = book.locator("img.BRpageimage").first();
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(360);
  expect(
    requests.some(
      ({ path }) => path === `${prefix}/api/documents/${documentId}/file`,
    ),
  ).toBe(true);
  expect(unscoped).toEqual([]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

test("native photo, attachment, and document dialogs offer a usable preview exit", async ({
  page,
}, info) => {
  for (const width of info.project.name === "desktop" ? [1024] : [320, 390]) {
    for (const kind of ["photo", "attachment", "document"] as const) {
      const tab = await page.context().newPage();
      try {
        await tab.setViewportSize({ width, height: 800 });
        const { unscoped } = await mockPreview(tab);
        if (kind === "photo") {
          await tab.goto(`${prefix}/photos`);
          await tab.getByRole("button", { name: /Все · по добавлению/ }).click();
          await tab.locator(".photo-tile").first().click();
        } else if (kind === "attachment") {
          await tab.goto(`${prefix}/people/child`);
          await tab.getByRole("tab", { name: /Обсуждение/ }).click();
          await tab.getByRole("button", { name: "Открыть изображение: Фото обсуждения.png" }).click();
        } else {
          await tab.goto(`${prefix}/documents/${documentId}`);
        }
        const dialog = tab.locator(
          kind === "photo" ? "dialog.photo-lightbox" :
          kind === "attachment" ? "dialog.discussion-lightbox" : "dialog.pdf-book-dialog",
        );
        await expect(dialog).toBeVisible();
        const banner = dialog.locator(".member-preview-banner");
        await expect(banner).toContainText(`Просмотр как участник: ${member.name}`);
        const bannerBox = (await banner.boundingBox())!;
        expect(bannerBox.y).toBeLessThanOrEqual(1);
        expect(bannerBox.x).toBeGreaterThanOrEqual(0);
        expect(bannerBox.x + bannerBox.width).toBeLessThanOrEqual(width + 1);
        expect(await banner.evaluate((element) => getComputedStyle(element).backgroundColor))
          .toBe("rgb(255, 244, 219)");
        const exit = dialog.getByRole("link", { name: "Выйти из просмотра", exact: true });
        await expect(exit).toHaveAttribute("href", "/a/preview-archive/manage");
        await exit.click({ trial: true });
        const box = await exit.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width).toBeGreaterThan(width * 0.7);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
        if (kind !== "document") {
          const close = dialog.getByRole("button", {
            name: kind === "photo" ? "Закрыть просмотр фото" : "Закрыть просмотр изображений",
          });
          const closeBox = await close.boundingBox();
          expect(closeBox).not.toBeNull();
          expect(
            box!.x + box!.width <= closeBox!.x ||
            closeBox!.x + closeBox!.width <= box!.x ||
            box!.y + box!.height <= closeBox!.y ||
            closeBox!.y + closeBox!.height <= box!.y,
          ).toBe(true);
          if (kind === "photo") {
            if (width < 900)
              await dialog.getByRole("button", { name: "О снимке" }).click();
            await dialog.locator(".photo-person-name").first().click();
            await expect(dialog.locator(".photo-person-sidebar")).toBeVisible();
            await exit.click({ trial: true });
            const personActions = await dialog.locator(".photo-person-sidebar-actions").boundingBox();
            expect(personActions).not.toBeNull();
            const profileHead = await dialog.locator(".photo-person-sidebar .profile-head").boundingBox();
            expect(profileHead).not.toBeNull();
            expect(personActions!.y + personActions!.height).toBeLessThanOrEqual(profileHead!.y + 1);
          }
        } else {
          const frame = dialog.locator("iframe.pdf-book-frame");
          await expect(frame).toHaveAttribute("allow", "fullscreen 'none'");
          const contentFrame = await (await frame.elementHandle())!.contentFrame();
          expect(await contentFrame!.evaluate(() => document.fullscreenEnabled)).toBe(false);
          const frameBox = await dialog.locator("iframe.pdf-book-frame").boundingBox();
          expect(frameBox).not.toBeNull();
          expect(box!.y + box!.height).toBeLessThanOrEqual(frameBox!.y + 1);
        }
        if (width === 320 || width === 1024)
          await tab.screenshot({ path: info.outputPath(`preview-${kind}-${width}.png`) });
        expect(unscoped).toEqual([]);
        await exit.click();
        await expect(tab).toHaveURL(/\/a\/preview-archive\/manage$/);
      } finally {
        await tab.close();
      }
    }
  }
});

test("revoked preview keeps a visible exit and never falls back to owner data", async ({
  page,
}) => {
  const { unscoped } = await mockPreview(page, true);
  await page.goto(`${prefix}/tree`);
  await expect(
    page.getByRole("link", { name: "Выйти из просмотра", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".flow-person")).toHaveCount(0);
  await expect(page.locator(".archive-status")).toBeVisible();
  expect(unscoped).toEqual([]);
});

test("default archive preview can exit after access is denied on reload", async ({
  page,
}) => {
  const { unscoped } = await mockPreview(page, true, "/preview/member%3Atest");
  await page.goto("/preview/member%3Atest/tree");
  const exit = page.getByRole("link", {
    name: "Выйти из просмотра",
    exact: true,
  });
  await expect(exit).toBeVisible();
  await expect(exit).toHaveAttribute("href", "/manage");
  await expect(page.locator(".flow-person")).toHaveCount(0);
  expect(unscoped).toEqual([]);
});

test("participants have a separate preview action alongside deletion", async ({
  page,
}, info) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/api/family"))
      return route.fulfill({
        json: {
          family: fullFamily,
          user: owner,
          revision: 1,
          canEdit: true,
          readTree: true,
          readPhotos: true,
        },
      });
    if (path.endsWith("/api/session"))
      return route.fulfill({
        json: {
          user: owner,
          local: false,
          account: {
            id: owner.id,
            name: owner.name,
            createdAt: owner.createdAt,
          },
        },
      });
    if (path.endsWith("/api/users"))
      return route.fulfill({
        json: {
          users: [
            member,
            {
              ...member,
              id: "pending",
              name: "Новый участник",
              approved: false,
            },
          ],
          next: null,
          total: 2,
        },
      });
    return route.fulfill({ json: { items: [], total: 0 } });
  });
  await page.goto("/a/preview-archive/manage");
  await page
    .getByRole("navigation", { name: "Разделы админки" })
    .getByRole("button", { name: "Участники", exact: true })
    .click();
  const row = page.getByRole("article", {
    name: `Участник: ${member.name}`,
    exact: true,
  });
  await expect(row.getByRole("combobox", { name: `Доступ к древу: ${member.name}` })
    .locator('option[value="common_ancestors"]')).toHaveText("Кровные родственники");
  await expect(
    row.getByRole("link", {
      name: `Посмотреть как участник: ${member.name}`,
      exact: true,
    }),
  ).toHaveAttribute("href", `${prefix}/tree`);
  await expect(
    row.getByRole("button", {
      name: `Удалить участника: ${member.name}`,
      exact: true,
    }),
  ).toBeVisible();
  for (const width of info.project.name === "desktop"
    ? [1000, 1024, 1440]
    : [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const participant of await page.locator(".admin-user-row").all())
      expect(await participant.evaluate((element) =>
        element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const actions = await page
      .locator(".admin-user-actions")
      .evaluateAll((groups) =>
        groups.map((group) =>
          [...group.querySelectorAll("a,button")].map((control) => {
            const rect = control.getBoundingClientRect();
            return {
              control: control.getAttribute("aria-label") || control.textContent,
              minHeight: getComputedStyle(control).minHeight,
              className: control.className,
              x: rect.x,
              right: rect.right,
              width: rect.width,
              height: rect.height,
            };
          }),
        ),
      );
    for (const group of actions)
      for (let index = 0; index < group.length; index++) {
        expect(group[index].width).toBeGreaterThanOrEqual(43.5);
        expect(group[index].height, JSON.stringify(group[index])).toBeGreaterThanOrEqual(43.5);
        if (index)
          expect(group[index].x).toBeGreaterThanOrEqual(group[index - 1].right);
      }
  }
});
