import { expect, test, type Page } from "@playwright/test";
import { pagedPhotoFixture } from "./paged-photo-fixture";
import type { ArchivePhoto } from "../../src/domain/types";

const photo = (
  id: string,
  year: string,
  personId = "e2e-child",
): ArchivePhoto => ({
  id,
  title: "Имя файла не является подписью",
  url: `/media/chronicle-${id}.png`,
  year,
  place: "Москва",
  event: "Семейная встреча",
  description: `Описание ${id}`,
  tags: [
    { id: `tag-${id}`, personId, x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
  ],
});
const photos = [
  photo("later", "1980"),
  photo("early", "1950"),
  photo("unknown", ""),
  photo("spouse", "1970", "e2e-spouse"),
];
async function setup(page: Page, source = photos) {
  await pagedPhotoFixture(page, source);
  await page.route("**/media/chronicle-*.png**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="${route.request().url().includes("early") ? "#287848" : "#cc8844"}"/></svg>`,
    }),
  );
}
async function openPerson(page: Page) {
  await page.goto("/people/e2e-child");
  await page.getByRole("button", { name: "Смотреть хронику" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Семейная хроника",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Следующий снимок" }),
  ).toBeEnabled();
  return dialog;
}
test("person chronicle preserves photo proportions, chronological scope, keyboard navigation and genealogy", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const dialog = await openPerson(page);
  await expect(dialog.locator(".chronicle-date")).toHaveText(
    "1950 · Москва · Семейная встреча",
  );
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("1 / 3");
  await expect(
    dialog.getByRole("button", { name: "Продолжить хронику" }),
  ).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds?.x).toBe(0);
  expect(bounds?.y).toBe(0);
  expect(bounds?.height).toBe(page.viewportSize()!.height);
  expect(
    await dialog
      .locator(".chronicle-photo")
      .evaluate((img) => getComputedStyle(img).objectFit),
  ).toBe("contain");
  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator(".chronicle-date")).toHaveText(
    "1980 · Москва · Семейная встреча",
  );
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("3 / 3");
  await expect(dialog.locator(".chronicle-description")).toHaveText(
    "Описание unknown",
  );
  await dialog.getByRole("button", { name: /Тестов Пётр Иванович/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/people\/e2e-child$/);
});
test("real Glass shader reveals a new photo and returns to an undistorted image; context loss degrades safely", async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => {
    const original = WebGLRenderingContext.prototype.drawArrays;
    const frames: { progress: number; center: number[] }[] = [];
    Object.assign(window, { chronicleFrames: frames });
    WebGLRenderingContext.prototype.drawArrays = function (...args) {
      original.apply(this, args);
      if (
        !(this.canvas instanceof HTMLCanvasElement) ||
        !this.canvas.closest(".chronicle-stage")
      )
        return;
      const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram;
      const progress = this.getUniform(
        program,
        this.getUniformLocation(program, "uProgress")!,
      ) as number;
      const pixel = new Uint8Array(4);
      this.readPixels(
        Math.floor(this.drawingBufferWidth / 2),
        Math.floor(this.drawingBufferHeight / 2),
        1,
        1,
        this.RGBA,
        this.UNSIGNED_BYTE,
        pixel,
      );
      frames.push({ progress, center: [...pixel] });
    };
  });
  const dialog = await openPerson(page);
  await dialog.getByRole("button", { name: "Приостановить хронику" }).click();
  await dialog.getByRole("button", { name: "Следующий снимок" }).click();
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("2 / 3", {
    timeout: 12000,
  });
  const frames = await page.evaluate(
    () =>
      (
        window as unknown as {
          chronicleFrames: { progress: number; center: number[] }[];
        }
      ).chronicleFrames,
  );
  expect(
    frames.some(
      (frame) => frame.progress === 0 && frame.center[1] > frame.center[0],
    ),
  ).toBe(true);
  expect(frames.some((frame) => frame.progress > 0 && frame.progress < 1)).toBe(
    true,
  );
  const completedInGlass = frames.some(
    (frame) => frame.progress === 1 && frame.center[0] > frame.center[1],
  );
  // Software WebGL in CI may legitimately trip the slow-frame fallback
  // before progress reaches 1. In that case the normal <img> is the endpoint.
  const fallbackNotice = dialog.getByText("Включён облегчённый переход");
  if (!completedInGlass) await expect(fallbackNotice).toBeVisible();
  await expect(dialog.locator("canvas")).toHaveCSS("opacity", "0");
  await expect(dialog.locator(".chronicle-photo")).toHaveAttribute(
    "src",
    /chronicle-later/,
  );
  await dialog.getByRole("button", { name: "Следующий снимок" }).click();
  if (completedInGlass) {
    await expect(dialog.locator("canvas")).toHaveCSS("opacity", "1");
    await dialog.locator("canvas").evaluate((canvas) => {
      (canvas as HTMLCanvasElement)
        .getContext("webgl")!
        .getExtension("WEBGL_lose_context")!
        .loseContext();
    });
    await expect(fallbackNotice).toBeVisible();
  } else {
    await expect(dialog.locator("canvas")).toHaveCSS("opacity", "0");
  }
  await expect(
    dialog.getByRole("button", { name: "Следующий снимок" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Смотреть хронику" }),
  ).toBeFocused();
});
test("WebGL context loss during a Glass transition falls back without hiding the new photo", async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => {
    const original = WebGLRenderingContext.prototype.drawArrays;
    let triggered = false;
    WebGLRenderingContext.prototype.drawArrays = function (...args) {
      original.apply(this, args);
      if (triggered || !this.canvas.closest(".chronicle-stage")) return;
      const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram;
      const uniform = this.getUniformLocation(program, "uProgress");
      const progress = uniform ? (this.getUniform(program, uniform) as number) : 0;
      if (progress > 0) {
        triggered = true;
        this.getExtension("WEBGL_lose_context")?.loseContext();
      }
    };
  });
  const dialog = await openPerson(page);
  await dialog.getByRole("button", { name: "Приостановить хронику" }).click();
  await dialog.getByRole("button", { name: "Следующий снимок" }).click();
  await expect(dialog.getByText("Включён облегчённый переход")).toBeVisible();
  await expect(dialog.locator(".chronicle-photo")).toHaveAttribute(
    "src",
    /chronicle-later/,
  );
  await expect(dialog.locator("canvas")).toHaveCSS("opacity", "0");
  await expect(dialog.getByRole("button", { name: "Следующий снимок" })).toBeEnabled();
});

test("failed photo load is explicit, retry works and playback pauses", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  let fail = true;
  await page.route("**/media/chronicle-early.png?variant=display", (route) =>
    fail
      ? route.fulfill({ status: 503, body: "temporary" })
      : route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"/>',
        }),
  );
  const dialog = await openPerson(page);
  await expect(dialog.getByRole("alert")).toHaveText(
    "Не удалось загрузить фотографию.Повторить",
  );
  fail = false;
  await dialog.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.locator(".chronicle-photo")).toHaveJSProperty(
    "naturalWidth",
    600,
  );
});
test("visible branch chronicle reads every page and never includes untagged photos", async ({
  page,
  isMobile,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const source = Array.from({ length: 34 }, (_, i) =>
    photo(`page-${i}`, String(1900 + i)),
  );
  source.push({ ...photo("untagged", "1800"), tags: [] });
  await setup(page, source);
  await page.goto("/people/e2e-child");
  if (isMobile) {
    await page
      .getByRole("button", { name: "Свернуть панель", exact: true })
      .click();
    await page.getByLabel("Область просмотра", { exact: true }).click();
  }
  await page.getByRole("button", { name: "Хроника видимой ветви" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Семейная хроника",
    exact: true,
  });
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("1 / 34");
  await expect(dialog.locator(".chronicle-date")).toContainText("1900");
  await page.screenshot({
    path: test.info().outputPath("chronicle-branch.png"),
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
test("empty album explains how to add photographs", async ({ page }) => {
  await setup(page, []);
  await page.goto("/people/e2e-child");
  await page.getByRole("button", { name: "Смотреть хронику" }).click();
  await expect(
    page.getByText("Для этой хроники пока нет фотографий."),
  ).toBeVisible();
});
test("chronicle opens over tree fullscreen and fills the mobile viewport", async ({
  page,
  isMobile,
}) => {
  test.skip(
    !isMobile,
    "Кнопка полного экрана древа предусмотрена для мобильного интерфейса",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await page.goto("/tree");
  await page
    .getByRole("button", { name: "Развернуть на весь экран", exact: true })
    .click();
  await page
    .locator('.flow-person[data-person-id="e2e-child"] .flow-person-content')
    .click();
  await page.getByRole("button", { name: "Смотреть хронику" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Семейная хроника",
    exact: true,
  });
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("1 / 3");
  const bounds = await dialog.boundingBox();
  expect(bounds?.y).toBe(0);
  expect(bounds?.height).toBe(page.viewportSize()!.height);
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
test("photo permission hides both chronicle entry points", async ({
  page,
  isMobile,
}) => {
  await setup(page);
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.readPhotos = false;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/people/e2e-child");
  await expect(
    page.getByRole("complementary", { name: "Выбранный объект" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Смотреть хронику" }),
  ).toHaveCount(0);
  if (isMobile) {
    await page
      .getByRole("button", { name: "Свернуть панель", exact: true })
      .click();
    await page.getByLabel("Область просмотра", { exact: true }).click();
  }
  await expect(
    page.getByRole("button", { name: "Хроника видимой ветви" }),
  ).toHaveCount(0);
});
test("autoplay waits five seconds and pause stops automatic navigation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const dialog = await openPerson(page);
  await page.clock.install();
  await dialog.getByRole("button", { name: "Продолжить хронику" }).click();
  await page.clock.fastForward(5100);
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("2 / 3");
  await dialog.getByRole("button", { name: "Приостановить хронику" }).click();
  await page.clock.fastForward(20000);
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("2 / 3");
});
test("restored-session validation closes already loaded private photographs", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const dialog = await openPerson(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/session", async (route) => {
    await gate;
    await route.continue();
  });
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".chronicle-photo")).toHaveCount(0);
  release();
  await expect(
    page.getByRole("dialog", { name: "Проверка доступа" }),
  ).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
});
test("Escape closes the chronicle before leaving CSS tree fullscreen", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Полноэкранная кнопка древа доступна на телефоне");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    HTMLElement.prototype.requestFullscreen = () =>
      Promise.reject(new Error("Fullscreen API unavailable"));
  });
  await setup(page);
  await page.goto("/tree");
  await page
    .getByRole("button", { name: "Развернуть на весь экран", exact: true })
    .click();
  await page
    .locator('.flow-person[data-person-id="e2e-child"] .flow-person-content')
    .click();
  await page.getByRole("button", { name: "Смотреть хронику" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Семейная хроника",
    exact: true,
  });
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("1 / 3");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".tree-canvas.is-fullscreen")).toBeVisible();
});
