import { expect, test } from "@playwright/test";

test("photo drag covers the viewport and accepts a drop outside the gallery content", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/photos");
  await expect(page.locator(".gallery-view .primary-action")).toBeVisible();

  const dragOnHeader = async (kind: "dragenter" | "drop") => {
    await page.locator(".archive-header").evaluate((header, eventKind) => {
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lYcAAAAASUVORK5CYII=",
        ),
        (character) => character.charCodeAt(0),
      );
      transfer.items.add(
        new File([bytes], "family.png", { type: "image/png" }),
      );
      header.dispatchEvent(
        new DragEvent(eventKind, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: 80,
          clientY: 40,
        }),
      );
    }, kind);
  };

  await dragOnHeader("dragenter");
  const overlay = page.locator(".gallery-drop-overlay");
  await expect(overlay).toBeVisible();
  const bounds = await overlay.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBe(0);
  expect(bounds!.y).toBe(0);
  expect(bounds!.width).toBe(viewport!.width);
  expect(bounds!.height).toBe(viewport!.height);

  await page.evaluate(() =>
    window.dispatchEvent(
      new DragEvent("dragleave", { clientX: -1, clientY: 40 }),
    ),
  );
  await expect(overlay).toHaveCount(0);

  await dragOnHeader("dragenter");
  await dragOnHeader("drop");
  await expect(overlay).toHaveCount(0);
  await expect(page.locator(".photo-upload-dialog[open]")).toBeVisible();
  await expect(
    page.locator(".photo-upload-dialog .photo-dropzone"),
  ).toContainText("family.png");
});
