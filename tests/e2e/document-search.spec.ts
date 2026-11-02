import { expect } from "@playwright/test";
import { test } from "./fixtures/document-server";
import type { ListedDocument } from "../../src/components/documents-catalog";

test("каталог сохраняет порядок поиска и показывает документ один раз", async ({
  page,
}) => {
  const documents: ListedDocument[] = [
    {
      id: "exact",
      title: "Точное совпадение",
      people: [
        { id: "z", name: "Яковлев Павел" },
        { id: "a", name: "Антонов Иван" },
      ],
    },
    {
      id: "partial",
      title: "Частичное совпадение",
      people: [{ id: "a", name: "Антонов Иван" }],
    },
    { id: "metadata", title: "Совпадение в описании", people: [] },
  ].map((item) => ({
    ...item,
    url: `/api/documents/${item.id}/file`,
    size: 100,
    createdAt: "2026-01-01",
    documentType: "",
    documentDate: "",
    place: "",
    description: "",
    provenance: "",
    eventLinks: [],
    pages: [],
    sources: [],
  }));
  await page.route("**/api/documents?**", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    return route.fulfill({
      json: {
        total: query === "нет совпадений" ? 0 : documents.length,
        items: query === "нет совпадений" ? [] : documents,
      },
    });
  });
  await page.goto("/documents");
  const input = page.getByRole("textbox", {
    name: "Найти документ или человека",
  });
  await expect(page.locator(".documents-group-heading h2")).toHaveText([
    "Антонов Иван",
    "Без привязки",
    "Яковлев Павел",
  ]);
  await input.fill("чепчугов павел");
  await expect(
    page.getByRole("heading", { name: "Результаты поиска" }),
  ).toBeVisible();
  await expect(page.locator(".document-item strong")).toHaveText(
    documents.map((document) => document.title),
  );
  await input.fill("нет совпадений");
  await expect(page.getByText("По запросу ничего не найдено.")).toBeVisible();
  await expect(page.locator(".documents-group")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Очистить поиск", exact: true })
    .click();
  await expect(page.locator(".documents-group-heading h2")).toHaveText([
    "Антонов Иван",
    "Без привязки",
    "Яковлев Павел",
  ]);
});
