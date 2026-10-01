import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { PersonComment } from "../../src/shared/person-discussion";

test("discussion diagrams, file previews and an image gallery work on desktop and mobile", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const endpoint = "/api/people/e2e-child/discussion";
  let items: PersonComment[] = [];
  let posted:
    | {
        text: string;
        attachments: {
          keep: string[];
          files: { name: string; data: string }[];
        };
      }
    | undefined;
  const originals = new Map<
    string,
    { bytes: Buffer; type: string; name: string }
  >();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/people/e2e-child/discussion**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const fileId = url.pathname.split("/attachments/")[1]?.split("/")[0];
    if (fileId) {
      const original = originals.get(fileId)!;
      const preview = url.pathname.endsWith("/preview");
      await route.fulfill({
        status: 200,
        body: preview
          ? await sharp(original.bytes).webp().toBuffer()
          : original.bytes,
        headers: {
          "Content-Type": preview ? "image/webp" : original.type,
          "Content-Disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(original.name)}`,
        },
      });
    } else if (request.method() === "POST") {
      posted = request.postDataJSON();
      const attachments = posted!.attachments.files.map((file) => {
        const id = randomUUID();
        const type = file.name.endsWith(".png") ? "image/png" : "text/plain";
        const bytes = Buffer.from(file.data, "base64");
        originals.set(id, { bytes, type, name: file.name });
        const url = `${endpoint}/100/attachments/${id}`;
        return {
          id,
          name: file.name,
          type,
          size: bytes.length,
          url,
          ...(type.startsWith("image/") && { previewUrl: `${url}/preview` }),
        };
      });
      const item: PersonComment = {
        id: 100,
        text: posted!.text,
        author: "Автор",
        authorPersonId: null,
        createdAt: new Date().toISOString(),
        editedAt: null,
        canEdit: true,
        canDelete: true,
        attachments,
      };
      items = [item];
      await route.fulfill({ status: 201, json: { item, total: items.length } });
    } else if (request.method() === "DELETE") {
      items = [];
      await route.fulfill({ json: { deleted: true, total: 0 } });
    } else if (url.searchParams.get("count") === "1") {
      await route.fulfill({ json: { total: items.length } });
    } else {
      await route.fulfill({
        json: { items, total: items.length, nextBefore: null },
      });
    }
  });
  await page.goto("/people/e2e-child");
  const tab = page.getByRole("tab", { name: "Обсуждение" });
  await expect(tab.locator(".count-badge")).toHaveText("0");
  await tab.click();
  const section = page.getByRole("region", { name: "Обсуждение человека" });
  await expect(
    section.getByRole("button", { name: "Исходный текст" }),
  ).toHaveCount(0);
  await expect(
    section.locator(".comment-editor-hint, .comment-editor-toolbar"),
  ).toHaveCount(0);
  await section.getByRole("button", { name: "Добавить схему Mermaid" }).click();
  await expect(
    section.locator(".comment-editor .comment-diagram svg"),
  ).toHaveCount(1);
  await expect(
    section.locator(".comment-editor .comment-diagram"),
  ).toContainText("Родитель");
  const red = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "#cf7462" },
  })
    .png()
    .toBuffer();
  const blue = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "#588db6" },
  })
    .png()
    .toBuffer();
  await section.getByLabel("Файлы для сообщения").setInputFiles([
    { name: "Красный.png", mimeType: "image/png", buffer: red },
    { name: "Синий.png", mimeType: "image/png", buffer: blue },
    {
      name: "Письмо.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Письмо из архива"),
    },
  ]);
  await expect(section.locator(".discussion-selected-files li")).toHaveCount(3);
  await section.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(section.locator(".person-discussion-item")).toHaveCount(1);
  expect(posted!.attachments.files.map((file) => file.name)).toEqual([
    "Красный.png",
    "Синий.png",
    "Письмо.txt",
  ]);
  expect(posted!.attachments.files[0].data).toBe(red.toString("base64"));
  await expect(tab.locator(".count-badge")).toHaveText("1");
  await expect(
    section.locator(".person-discussion-item .comment-diagram svg"),
  ).toHaveCount(1);
  await expect(
    section.locator(".discussion-image-previews button"),
  ).toHaveCount(2);
  await section
    .locator(".person-discussion-item")
    .screenshot({ path: info.outputPath("discussion-attachments.png") });
  const downloadEvent = page.waitForEvent("download");
  await section.getByRole("link", { name: /Письмо.txt/ }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("Письмо.txt");
  await section
    .getByRole("button", { name: "Открыть изображение: Красный.png" })
    .click();
  const gallery = page.getByRole("dialog", { name: "Изображения сообщения" });
  await expect(gallery).toBeVisible();
  await expect(gallery.locator("header")).toContainText("Красный.png · 1 / 2");
  await expect(gallery.locator(".photo-slide-current img")).not.toHaveAttribute(
    "src",
    /preview$/,
  );
  await gallery.getByRole("button", { name: "Следующее изображение" }).click();
  await expect(gallery.locator("header")).toContainText("Синий.png · 2 / 2");
  await page.keyboard.press("ArrowLeft");
  await expect(gallery.locator("header")).toContainText("Красный.png · 1 / 2");
  const bounds = (await gallery
    .locator(".discussion-gallery-space")
    .boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width * 0.75,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.2,
    bounds.y + bounds.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(gallery.locator("header")).toContainText("Синий.png · 2 / 2");
  await gallery.screenshot({ path: info.outputPath("discussion-gallery.png") });
  await page.keyboard.press("Escape");
  await expect(gallery).toHaveCount(0);
  await page.reload();
  await tab.click();
  await expect(
    section.locator(".discussion-image-previews button"),
  ).toHaveCount(2);
  await section
    .getByRole("button", { name: "Удалить сообщение", exact: true })
    .click();
  await section.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(tab.locator(".count-badge")).toHaveText("0");
  expect(errors).toEqual([]);
});

test("an invalid or configured Mermaid block remains readable without breaking the editor", async ({
  page,
}) => {
  await page.goto("/people/e2e-child");
  await page.getByRole("tab", { name: "Обсуждение" }).click();
  const editor = page.getByRole("textbox", {
    name: "Сообщение для обсуждения",
  });
  await editor.click();
  await page.keyboard.insertText(
    "```mermaid\n%%{init: {securityLevel: 'loose'}}%%\ngraph TD\nA --> B\n```\n\n",
  );
  const error = page.locator(".comment-editor .comment-diagram.is-error");
  await expect(error).toContainText("Проверьте синтаксис Mermaid");
  await expect(error.locator("pre")).toContainText("securityLevel");
  await expect(error.locator("script, iframe, foreignObject")).toHaveCount(0);
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText("Обычный текст после схемы");
  await expect(editor).toContainText("Обычный текст после схемы");
});
