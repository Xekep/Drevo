import { expect, test } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lYcAAAAASUVORK5CYII=",
  "base64",
);

for (const marker of ["accessChanged", "refreshRequired"] as const) {
  test(`photo upload reports an already committed ${marker} result`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "Gallery upload is desktop-only");
    let posts = 0;
    await page.route("**/api/photos", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      return route.fulfill({ status: 201, json: { committed: true, [marker]: true } });
    });
    await page.goto("/photos");
    await page.locator(".gallery-view .primary-action").click();
    const form = page.locator(".photo-upload-dialog");
    await expect(form).toBeVisible();
    await form.locator('input[type="file"]').setInputFiles({
      name: "synthetic-photo.png", mimeType: "image/png", buffer: png,
    });
    await form.locator(".photo-upload-form .primary-action").click();
    await expect.poll(() => posts).toBe(1);
    const savedMessage = /Фотография сохранена, но (доступ изменился|архив изменился)/;
    if (marker === "accessChanged") {
      await expect(page.getByRole("status").filter({ hasText: savedMessage })).toBeVisible();
      await expect(page.locator(".gallery-view .primary-action")).toHaveCount(0);
      await page.getByRole("button", { name: "Закрыть уведомление" }).click();
      await expect(page.getByRole("status").filter({ hasText: savedMessage })).toHaveCount(0);
    } else {
      await expect(form.getByRole("alert")).toContainText(savedMessage);
      await expect(form).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await form.locator("footer .text-action").click();
      await expect(page.locator(".gallery-view .primary-action")).toBeVisible();
    }
    await expect(page.locator(".photo-viewer")).toHaveCount(0);
    expect(posts).toBe(1);
  });
}

for (const marker of ["accessChanged", "refreshRequired"] as const) {
  test(`portrait upload keeps its draft after an already committed ${marker} result`, async ({ page }, info) => {
    const source = {
      id: "synthetic-portrait-source",
      url: "/media/synthetic-portrait-source.png",
      title: "Synthetic portrait source",
      tags: [{ id: "synthetic-portrait-tag", personId: "e2e-child",
        x: 0, y: 0, width: 1, height: 1 }],
    };
    await page.route("**/api/family?projection=overview", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.totals.photos = 1;
      await route.fulfill({ response, json: data });
    });
    await page.route("**/api/family?projection=page&collection=photos&**", (route) => {
      const pageToken = new URL(route.request().url()).searchParams.get("token");
      return route.fulfill({ json: { pageToken, total: 1, items: [source] } });
    });
    await page.route("**/api/family?projection=page&collection=people&**", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.items = data.items.map((person: { id: string }) => person.id === "e2e-child"
        ? { ...person, photo: "/media/existing-portrait.png" } : person);
      await route.fulfill({ response, json: data });
    });
    await page.route("**/media/*.png**", (route) =>
      route.fulfill({ contentType: "image/png", body: png }),
    );
    let portraitPosts = 0;
    let familyPosts = 0;
    await page.route("**/api/portraits", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      portraitPosts++;
      return route.fulfill({ status: 201, json: { committed: true, [marker]: true } });
    });
    await page.route("**/api/family/changes", (route) => {
      if (route.request().method() === "POST") familyPosts++;
      return route.continue();
    });
    await page.goto("/tree");
    const card = page.getByTestId("rf__node-e2e-child").locator(".flow-person-content");
    if (info.project.name === "mobile") await card.tap();
    else await card.click();
    await page.locator(".inspector-person-actions .person-edit-button").click();
    const form = page.locator(".person-editor-form");
    await expect(form).toBeVisible();
    await form.locator('input[data-field="name"]').fill("Тестов Павел Иванович");
    await form.locator(".portrait-preview").click();
    await page.locator(".portrait-gallery button").first().click();
    await page.locator(".portrait-cropper .primary-action").click();
    await expect(form.locator(".portrait-preview img")).toHaveAttribute("src", /^blob:/);
    await form.locator("footer .primary-action").click();
    await expect.poll(() => portraitPosts).toBe(1);
    expect(familyPosts).toBe(0);
    if (marker === "accessChanged") {
      await expect(page.getByRole("status").filter({ hasText: /Портрет загружен, но доступ изменился/ }))
        .toBeVisible();
      await expect(form).toBeHidden();
      await page.reload();
      await expect(page.getByTestId("rf__node-e2e-child")).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: /Портрет загружен, но доступ изменился/ }))
        .toHaveCount(0);
    } else {
      await expect(form.getByRole("alert")).toContainText("Портрет загружен, но архив изменился");
      await expect(form.locator('input[data-field="name"]')).toHaveValue("Тестов Павел Иванович");
      await expect(form.locator(".portrait-preview img")).toHaveAttribute("src", /^blob:/);
      await expect(page.getByRole("status").filter({ hasText: /Портрет загружен, но архив изменился/ }))
        .toHaveCount(0);
    }
    expect(portraitPosts).toBe(1);
    expect(familyPosts).toBe(0);
  });
}
