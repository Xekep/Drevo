import { expect, test } from "@playwright/test";

test("quality center separates relationship hints from missing evidence", async ({
  page,
}) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const child = data.family.people.find(
      (person: { id: string }) => person.id === "e2e-grandchild",
    );
    child.parents = ["e2e-child", "e2e-spouse", "e2e-memorial-person"];
    child.sources = [];
    child.birth = "2000";
    child.birthDateClaim = { value: "2000", sources: [{ title: "Запись о рождении", type: "архив", reference: "л. 1" }], confidence: "probable" };
    child.birthPlace = "Тверь";
    child.birthPlaceClaim = { value: "Тверь", sources: [{ title: "Запись о месте", type: "архив", reference: "л. 2" }], confidence: "conflicting" };
    child.events = [
      { id: "e2e-unsourced", type: "move", title: "Переезд", date: "2015" },
    ];
    await route.fulfill({ response, json: data });
  });
  await page.goto("/quality");
  await expect(
    page.getByRole("heading", { name: "Проверка данных" }),
  ).toBeVisible();
  await expect(page.getByText("Больше двух кровных родителей")).toBeVisible();
  await page.getByRole("button", { name: /Неподтверждённые факты/ }).click();
  await expect(
    page.getByText("Событие без прикреплённого источника"),
  ).toBeVisible();
  await expect(page.getByText("Цитируемые факты ещё не подтверждены оценкой исследователя")).toBeVisible();
  await expect(page.getByText("Факты с ручной оценкой «Противоречиво»")).toHaveCount(0);
  await expect(page.getByText("Больше двух кровных родителей")).toHaveCount(0);
  await page.getByRole("button", { name: /Противоречия/ }).click();
  await expect(page.getByText("Факты с ручной оценкой «Противоречиво»")).toBeVisible();
  await expect(page.getByText("Цитируемые факты ещё не подтверждены оценкой исследователя")).toHaveCount(0);
  await page.getByRole("button", { name: /Пробелы исследования/ }).click();
  await expect(
    page.getByText("Нет точных источников для жизненных данных").first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /Возможные ошибки/ }).click();
  await expect(page.getByText("Больше двух кровных родителей")).toBeVisible();
});
