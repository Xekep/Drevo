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
  photo: "/media/preview-portrait.png",
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
  ],
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
  unions: [],
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
          user: member,
          account: null,
          local: false,
          preview: true,
        },
      });
    if (path === "/api/family")
      return route.fulfill({
        json: {
          family,
          user: member,
          revision: 1,
          canEdit: false,
          local: false,
          readTree: true,
          readPhotos: true,
          treePreferences: {},
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
              attachments: [],
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
    ? [1024, 1440]
    : [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const actions = await page
      .locator(".admin-user-actions")
      .evaluateAll((groups) =>
        groups.map((group) =>
          [...group.querySelectorAll("a,button")].map((control) => {
            const rect = control.getBoundingClientRect();
            return {
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
        expect(group[index].height).toBeGreaterThanOrEqual(43.5);
        if (index)
          expect(group[index].x).toBeGreaterThanOrEqual(group[index - 1].right);
      }
  }
});
