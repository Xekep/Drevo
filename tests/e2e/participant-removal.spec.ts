import { expect, test } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";

test("participant removal needs two presses and can be cancelled without deleting an account", async ({
  page,
}) => {
  let deleted = false;
  let deletes = 0;
  await page.route("**/api/users?**", (route) =>
    route.fulfill({
      json: {
        users: deleted
          ? []
          : [
              {
                id: "member-delete",
                name: "Анна Участница",
                treeRole: "reader",
                role: "reader",
                archiveOwner: false,
                approved: true,
                createdAt: "2026-01-01",
              },
            ],
        next: null,
        total: deleted ? 0 : 1,
      },
    }),
  );
  await page.route("**/api/users/member-delete", (route) => {
    expect(route.request().method()).toBe("DELETE");
    deletes++;
    deleted = true;
    return route.fulfill({ json: { deleted: true } });
  });
  await page.route("**/api/account/delete**", () => {
    throw new Error("Participant removal must never call account deletion");
  });
  await page.goto("/manage");
  await openAdminSection(page, "users", "Участники");
  const remove = page.getByRole("button", {
    name: "Удалить участника: Анна Участница",
  });
  await remove.click();
  expect(deletes).toBe(0);
  const confirm = page.getByRole("button", {
    name: "Подтвердить удаление участника: Анна Участница",
  });
  await expect(
    page
      .getByRole("article", { name: "Участник: Анна Участница" })
      .getByRole("status"),
  ).toContainText("Аккаунт и данные в древе сохранятся");
  await confirm.press("Escape");
  await expect(remove).toBeVisible();
  expect(deletes).toBe(0);
  await remove.focus();
  await page.keyboard.down("Enter");
  await expect(confirm).toBeVisible();
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await expect(confirm).toBeVisible();
  expect(deletes).toBe(0);
  await confirm.press("Escape");
  await remove.click();
  await confirm.press("Tab");
  await expect(remove).toBeVisible();
  expect(deletes).toBe(0);
  await remove.click();
  await confirm.click();
  await expect.poll(() => deletes).toBe(1);
  await expect(
    page.getByRole("article", { name: "Участник: Анна Участница" }),
  ).toHaveCount(0);
});
