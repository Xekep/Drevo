import { expect, test } from "@playwright/test";
import type { Family } from "../../src/domain/types.ts";

test("tree import previews a JSON batch and preserves every existing card", async ({
  page,
  request,
}, info) => {
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
    if (info.project.name === "mobile")
      await page.getByRole("button", { name: "Импорт", exact: true }).click();
    else {
      await page
        .locator(".react-flow__pane")
        .click({ button: "right", position: { x: 40, y: 350 } });
      await expect(
        page.getByRole("menuitem", { name: "Экспорт древа" }),
      ).toBeVisible();
      await page.getByRole("menuitem", { name: "Импорт", exact: true }).click();
    }
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
