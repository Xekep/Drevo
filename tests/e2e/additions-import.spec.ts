import { expect, test } from "@playwright/test";
import type { Family } from "../../src/domain/types.ts";

for (const shared of [false, true])
  test(`mobile ${shared ? "shared" : "own"} tree hides import and export`, async ({
    page,
    request,
    isMobile,
  }) => {
    test.skip(!isMobile);
    const token = "i".repeat(43);
    if (shared) {
      const { family } = await (await request.get("/api/family")).json();
      await page.route(`**/api/shared/${token}`, (route) =>
        route.fulfill({
          json: {
            family,
            reverseTimeline: false,
            serverTime: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        }),
      );
    }
    await page.goto(shared ? `/s/${token}` : "/tree");
    await expect(
      page.getByRole("button", { name: "Настройки древа" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Импорт", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Экспорт древа" }),
    ).toHaveCount(0);
    await page.locator(".react-flow__pane").click({
      button: "right",
      position: { x: 20, y: 350 },
    });
    await expect(
      page.getByRole("menuitem", { name: "Импорт", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: "Экспорт древа" }),
    ).toHaveCount(0);
  });

test("tree import previews a JSON batch and preserves every existing card", async ({
  page,
  request,
  isMobile,
}, info) => {
  test.skip(isMobile, "Пакетный импорт с полотна доступен на десктопе");
  const original = await (await request.get("/api/family")).json();
  const newId = `batch-e2e-${info.project.name}`;
  const packet = {
    format: "drevo.reviewed-add-only",
    version: 1,
    existingPeople: [],
    newPeople: [
      {
        id: newId,
        name: "Пакетный",
        surname: "Тест",
        sex: "m",
        birth: "1990",
        parents: ["e2e-child"],
        sources: [
          { title: "Тестовый источник", type: "Книга", reference: "с. 7" },
        ],
      },
    ],
  };
  try {
    await page.goto("/tree");
    await page
      .locator(".react-flow__pane")
      .click({ button: "right", position: { x: 40, y: 350 } });
    await expect(
      page.getByRole("menuitem", { name: "Экспорт древа" }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Импорт", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Импорт в древо" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("JSON с новыми карточками").setInputFiles({
      name: "batch.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(packet)),
    });
    await dialog.getByRole("button", { name: "Проверить пакет JSON" }).click();
    const add = dialog.getByRole("button", { name: "Добавить 1 карточек" });
    await expect(add).toBeEnabled();
    expect(
      (await (await request.get("/api/family")).json()).family.people,
    ).toEqual(original.family.people);
    await add.click();
    await expect(dialog.getByRole("status")).toContainText(
      "Добавлено карточек: 1",
    );
    const saved = await (await request.get("/api/family")).json();
    expect(
      saved.family.people.filter((p: { id: string }) => p.id !== newId),
    ).toEqual(original.family.people);
    expect(
      saved.family.people.find((p: { id: string }) => p.id === newId),
    ).toMatchObject({
      needsReview: true,
      parents: ["e2e-child"],
      sources: packet.newPeople[0].sources,
    });
    // Same file cannot duplicate the inserted card.
    await dialog.getByLabel("JSON с новыми карточками").setInputFiles({
      name: "batch.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(packet)),
    });
    await dialog.getByRole("button", { name: "Проверить пакет JSON" }).click();
    await expect(dialog.getByRole("alert")).toContainText("уже существует");
    await expect(
      dialog.getByRole("button", { name: "Добавить 1 карточек" }),
    ).toHaveCount(0);
    const undo = dialog.getByRole("region", { name: "Отмена импорта" });
    await undo
      .getByRole("button", { name: "Показать импортированные пакеты" })
      .click();
    await undo
      .getByRole("button", {
        name: `Проверить отмену импорта №${saved.revision}`,
        exact: true,
      })
      .click();
    await expect(
      undo.getByText("Будет удалено карточек: 1 из 1"),
    ).toBeVisible();
    const remove = undo.getByRole("button", {
      name: "Отменить импорт и удалить 1 карточек",
    });
    await expect(remove).toBeDisabled();
    expect(
      (await (await request.get("/api/family")).json()).family.people.length,
    ).toBe(saved.family.people.length);
    await undo
      .getByRole("checkbox", {
        name: "Удалить перечисленные карточки этого импорта",
      })
      .check();
    await remove.click();
    await expect(undo.getByRole("status")).toContainText("Удалено карточек: 1");
    const restored = await (await request.get("/api/family")).json();
    expect(restored.family).toEqual(original.family);
    await undo
      .getByRole("button", { name: "Показать импортированные пакеты" })
      .click();
    await expect(
      undo.getByRole("button", {
        name: `Проверить отмену импорта №${saved.revision}`,
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    const current = await (await request.get("/api/family")).json();
    const p = (current.family as Family).people.find((p) => p.id === newId);
    if (p) {
      const result = await request.post("/api/family/changes", {
        headers: { "If-Match": String(current.revision) },
        data: { changes: [{ collection: "people", id: newId, before: p }] },
      });
      expect(result.status()).toBe(200);
    }
  }
});
