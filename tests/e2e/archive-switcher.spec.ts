import { test, expect } from "@playwright/test";

test("menu switches between owned and invited archives without offering pending access", async ({
  page,
}) => {
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
          },
          {
            id: "invited-archive",
            title: "Древо родственника",
            current: false,
            owned: false,
            approved: true,
          },
          {
            id: "pending-archive",
            title: "Ожидающее древо",
            current: false,
            owned: false,
            approved: false,
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
  const link = dialog.getByRole("link", { name: "Открыть" });
  await expect(link).toHaveAttribute("href", "/a/invited-archive/tree");
  await expect(dialog.getByText("Ожидает доступа")).toBeVisible();
  await expect(dialog.getByRole("link")).toHaveCount(1);
  await link.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Меню проекта", { exact: true })).toBeFocused();
});
