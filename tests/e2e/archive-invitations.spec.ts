import { expect, test } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";

const token = "a".repeat(43);
const joinPath = `/join/family-one/${token}`;

test("an invited account can accept a selected archive link", async ({
  page,
}) => {
  await page.route("**/api/account/invitations/preview", (route) =>
    route.fulfill({
      json: { archiveId: "family-one", title: "Родовое древо", role: "reader" },
    }),
  );
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: { account: { name: "Анна" }, yandex: true, vk: false },
    }),
  );
  await page.route("**/api/account/invitations/accept", (route) =>
    route.fulfill({
      json: { archiveId: "family-one", path: "/a/family-one/tree" },
    }),
  );
  await page.goto(joinPath);
  await expect(
    page.getByRole("heading", { name: "Родовое древо" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Присоединиться" }).click();
  await expect(page).toHaveURL(/\/a\/family-one\/tree$/);
});

test("sign-in returns an anonymous visitor to their invitation", async ({
  page,
}) => {
  let signedIn = false;
  await page.route("**/api/account/invitations/preview", (route) =>
    route.fulfill({
      json: { archiveId: "family-one", title: "Родовое древо", role: "reader" },
    }),
  );
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        account: signedIn ? { name: "Анна" } : null,
        yandex: true,
        vk: false,
      },
    }),
  );
  await page.route("**/auth/yandex", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>OAuth</title>" }),
  );
  await page.goto(joinPath);
  await page.getByRole("button", { name: "Войти через Яндекс" }).click();
  await expect(page).toHaveURL(/\/auth\/yandex$/);
  expect(
    await page.evaluate(() => sessionStorage.getItem("drevo_pending_invite")),
  ).toBe(joinPath);
  signedIn = true;
  await page.goto("/tree");
  await expect(page).toHaveURL(new RegExp(`${joinPath}$`));
  await expect(
    page.getByRole("button", { name: "Присоединиться" }),
  ).toBeVisible();
});

test("an archive admin creates and revokes a one-use invitation", async ({
  page,
}) => {
  let issued = false;
  let revoked = false;
  const record = {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "reader",
    createdAt: "2026-09-30T08:00:00.000Z",
    expiresAt: "2099-01-01T08:00:00.000Z",
    usedAt: null,
    revokedAt: null as string | null,
  };
  await page.route("**/api/invitations", (route) => {
    if (route.request().method() === "POST") {
      issued = true;
      return route.fulfill({
        status: 201,
        json: {
          id: record.id,
          role: "reader",
          expiresAt: record.expiresAt,
          path: `/join/family-one/${token}`,
        },
      });
    }
    return route.fulfill({
      json: {
        invitations: issued
          ? [{ ...record, revokedAt: revoked ? "2026-09-30T09:00:00Z" : null }]
          : [],
      },
    });
  });
  await page.route("**/api/invitations/*", (route) => {
    revoked = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/manage");
  await openAdminSection(page, "invitations", "Приглашения");
  await page.getByRole("button", { name: "Создать ссылку" }).click();
  await expect(
    page.getByRole("textbox", { name: "Ссылка для отправки" }),
  ).toHaveValue(new RegExp(`/join/family-one/${token}$`));
  await expect(page.getByText("Ожидает", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Отозвать" }).click();
  await expect(page.getByText("Отозвано", { exact: true })).toBeVisible();
});

test("invitation scope is blood plus partners only with a selected identity", async ({
  page,
}) => {
  const requests: Array<Record<string, unknown>> = [];
  const person = (await (await page.request.get("/api/family")).json()).family
    .people[0];
  await page.route("**/api/invitations", (route) => {
    if (route.request().method() === "POST") {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        status: 201,
        json: { path: `/join/family-one/${token}` },
      });
    }
    return route.fulfill({ json: { invitations: [] } });
  });
  await page.goto("/manage");
  await openAdminSection(page, "invitations", "Приглашения");
  await expect(page.getByLabel("Доступ к древу", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Роль", { exact: true }).selectOption("relative");
  await page
    .getByRole("combobox", { name: "Кто это в древе", exact: true })
    .fill(`${person.surname} ${person.name}`);
  await page
    .getByRole("option")
    .filter({ hasText: `${person.surname} ${person.name}` })
    .first()
    .click();
  await page
    .getByLabel("Доступ к древу", { exact: true })
    .selectOption("common_ancestors");
  await page.getByRole("button", { name: "Создать ссылку" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    role: "relative",
    personId: person.id,
    treeAccess: "common_ancestors",
  });
  await page.getByRole("button", { name: "Выбрать другого человека" }).click();
  await expect(page.getByLabel("Доступ к древу", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Создать ссылку" }).press("Enter");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({
    role: "relative",
    personId: null,
    treeAccess: "all",
  });
});
