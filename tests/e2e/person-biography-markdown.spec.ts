import { expect, test } from "@playwright/test";
import type { Family } from "../../src/domain/types";

test("saved biography renders Markdown and line breaks without executing HTML", async ({
  page,
  request,
}, info) => {
  const initial = await (await request.get("/api/family")).json();
  const person = (initial.family as Family).people.find(
    (p) => p.id === "e2e-child",
  )!;
  const biography =
    "**Семейная история** и *воспоминания*\nСледующая строка\n\n## Документы\n\n- Первый пункт\n- Второй пункт\n\n> Из семейного архива\n\n[Источник](https://example.com/archive)\n\n| Год | Место |\n| --- | --- |\n| 1900 | Посёлок |\n\n<script>window.biographyUnsafe = true</script>\n\n[Опасная ссылка](javascript:alert(1))";
  const open = async () => {
    await page
      .getByTestId("rf__node-e2e-child")
      .locator(".flow-person-content")
      .click();
    await expect(
      page.locator(".inspector-person-actions .person-edit-button"),
    ).toBeVisible();
  };
  const verify = async () => {
    const content = page.locator(".inspector-dock .person-biography-text");
    await expect(content.locator("strong")).toHaveText("Семейная история");
    await expect(content.locator("em")).toHaveText("воспоминания");
    await expect(
      content.getByRole("heading", { name: "Документы" }),
    ).toBeVisible();
    await expect(content.locator("li")).toHaveCount(2);
    await expect(content.locator("ul")).toHaveCSS("list-style-type", "disc");
    await expect(content.locator("blockquote")).toContainText(
      "Из семейного архива",
    );
    await expect(content.locator("table")).toContainText("1900");
    const paragraph = content.locator("p").first();
    await expect(paragraph).toHaveCSS("white-space", "pre-wrap");
    expect(await paragraph.textContent()).toBe(
      "Семейная история и воспоминания\nСледующая строка",
    );
    const lineTops = await paragraph.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].map((rect) => rect.top);
    });
    expect(new Set(lineTops).size).toBeGreaterThan(1);
    await expect(
      content.locator("script, [onerror], a[href^='javascript:']"),
    ).toHaveCount(0);
    await expect(
      content.getByRole("link", { name: "Источник", exact: true }),
    ).toHaveAttribute("href", "https://example.com/archive");
    await expect(
      content.getByRole("link", { name: "Источник", exact: true }),
    ).toHaveAttribute("rel", "noopener noreferrer");
    expect(await page.evaluate(() => "biographyUnsafe" in window)).toBe(false);
    expect(
      await content.evaluate(
        (node) => node.scrollWidth <= node.clientWidth + 1,
      ),
    ).toBe(true);
  };
  try {
    await page.goto("/tree");
    await open();
    await page.locator(".inspector-person-actions .person-edit-button").click();
    await page.getByText("Жизнь и занятия", { exact: true }).click();
    await page
      .getByRole("textbox", { name: "История человека" })
      .fill(biography);
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Редактировать человека" }),
    ).toHaveCount(0);
    await verify();
    await page.reload();
    await open();
    await verify();
    await page.locator(".person-biography-text").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("person-biography-markdown.png"),
    });
    await page.locator(".inspector-person-actions .person-edit-button").click();
    await page.getByText("Жизнь и занятия", { exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "История человека" }),
    ).toHaveValue(biography);
  } finally {
    const current = await (await request.get("/api/family")).json();
    const stored = (current.family as Family).people.find(
      (p) => p.id === person.id,
    )!;
    const restored = await request.post("/api/family/changes", {
      headers: { "If-Match": String(current.revision) },
      data: {
        changes: [
          {
            collection: "people",
            id: person.id,
            field: "biography",
            before: stored.biography,
            after: person.biography,
          },
        ],
      },
    });
    expect(restored.status()).toBe(200);
  }
});
