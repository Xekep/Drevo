import { expect, test, type Page } from "@playwright/test";
import { pagedPhotoFixture } from "./paged-photo-fixture";
import type { ArchivePhoto } from "../../src/domain/types";
import { defaultChronicleSettings, chronicleEffects, chroniclePresets, type ChronicleEffect } from "../../src/shared/chronicle-settings";

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
  await page.route("**/api/family?projection=details&preview=1&**", async route => {
    const response = await route.fetch();
    const data = await response.json();
    const ids = JSON.parse(new URL(route.request().url()).searchParams.get("ids")!) as string[];
    const album = source.filter(photo => photo.tags.some(tag => ids.includes(tag.personId)));
    await route.fulfill({ response, json: { ...data, photos: album.slice(0, 30), photoTotal: album.length,
      personPhotoTotals: Object.fromEntries(ids.map(id => [id, source.filter(photo => photo.tags.some(tag => tag.personId === id)).length])) } });
  });
  await page.route("**/media/chronicle-*.png**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="${route.request().url().includes("early") ? "#287848" : "#cc8844"}"/></svg>`,
    }),
  );
}
async function launchChronicle(page: Page) {
  await expect(page.getByRole("button", { name: "Хроника", exact: true, includeHidden: true })).toHaveCount(1);
  const collapse = page.getByRole("button", { name: "Свернуть панель", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  const launch = page.getByRole("button", { name: "Хроника", exact: true });
  const menu = page.locator(".tree-family-menu > summary");
  if (await menu.isVisible()) {
    await expect(page.locator(".tree-canvas")).not.toHaveAttribute("inert");
    if (!await launch.isVisible()) {
      await menu.click();
      await expect(page.locator(".tree-family-menu")).toHaveAttribute("open", "");
    }
  }
  await expect(launch).toHaveCount(1);
  await launch.click();
}
async function openPerson(page: Page) {
  await page.goto("/people/e2e-child");
  await launchChronicle(page);
  const dialog = page.getByRole("dialog", {
    name: "Семейная хроника",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Листать хронику дальше" }),
  ).toBeEnabled();
  return dialog;
}
test("person chronicle preserves photo proportions, chronological scope, keyboard navigation and genealogy", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const dialog = await openPerson(page);
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expect(dialog.locator(".chronicle-help")).toHaveCount(0);
  const playback = dialog.locator("header .chronicle-playback-toggle");
  await expect(playback).toHaveText("");
  await expect(playback.locator("svg")).toHaveCount(1);
  const playbackBox = (await playback.boundingBox())!;
  const closeBox = (await dialog.getByRole("button", { name: "Закрыть", exact: true }).boundingBox())!;
  expect(Math.abs(playbackBox.y - closeBox.y)).toBeLessThan(2);
  expect(closeBox.x - playbackBox.x - playbackBox.width).toBeGreaterThanOrEqual(0);
  expect(closeBox.x - playbackBox.x - playbackBox.width).toBeLessThanOrEqual(20);
  await expect(dialog.locator(".chronicle-caption-summary")).toHaveText(
    "1950 · Москва",
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
  await expect(dialog.locator(".chronicle-caption-summary")).toHaveText(
    "1980 · Москва",
  );
  await expect(dialog.getByRole("button", { name: "Листать хронику дальше" })).toBeEnabled();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("3 / 3");
  await expect(dialog.locator(".chronicle-description")).toHaveText(
    "Описание unknown",
  );
  await dialog.locator(".chronicle-caption-summary").click();
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
  await dialog.getByRole("button", { name: "Листать хронику дальше" }).click();
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("2 / 3", {
    timeout: 12000,
  });
  await expect(dialog.getByRole("button", { name: "Листать хронику дальше" })).toBeEnabled();
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
  if (!completedInGlass) await expect(fallbackNotice).toHaveText("Включён облегчённый переход");
  await expect(dialog.locator(".chronicle-transition")).toHaveCSS(
    "opacity",
    "0",
  );
  await expect(dialog.locator(".chronicle-photo")).toHaveAttribute(
    "src",
    /chronicle-later/,
  );
  const usingGlass = !await fallbackNotice.isVisible();
  if (usingGlass) {
    // Arm loss before navigation: on a slow runner the whole transition may
    // finish before a locator can observe the transient canvas opacity.
    await dialog.locator(".chronicle-transition").evaluate((canvas) => {
      const gl = (canvas as HTMLCanvasElement).getContext("webgl")!;
      const draw = gl.drawArrays;
      gl.drawArrays = function (...args) {
        draw.apply(this, args);
        gl.drawArrays = draw;
        gl.getExtension("WEBGL_lose_context")!.loseContext();
      };
    });
  }
  await dialog.getByRole("button", { name: "Листать хронику дальше" }).click();
  if (usingGlass) {
    await expect(fallbackNotice).toHaveText("Включён облегчённый переход");
  } else {
    await expect(dialog.locator(".chronicle-transition")).toHaveCSS(
      "opacity",
      "0",
    );
  }
  await expect(
    dialog.getByRole("button", { name: "Листать хронику дальше" }),
  ).toBeEnabled();
  await expect(dialog.locator(".chronicle-photo")).toHaveAttribute("src", /chronicle-unknown/);
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.viewportSize()!.width < 600 ? page.locator(".tree-family-menu > summary") : page.getByRole("button", { name: "Хроника" })).toBeFocused();
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
      if (
        triggered ||
        !(this.canvas instanceof HTMLCanvasElement) ||
        !this.canvas.closest(".chronicle-stage")
      )
        return;
      const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram;
      const uniform = this.getUniformLocation(program, "uProgress");
      const progress = uniform
        ? (this.getUniform(program, uniform) as number)
        : 0;
      if (progress > 0) {
        triggered = true;
        this.getExtension("WEBGL_lose_context")?.loseContext();
      }
    };
  });
  const dialog = await openPerson(page);
  await dialog.getByRole("button", { name: "Приостановить хронику" }).click();
  await dialog.getByRole("button", { name: "Листать хронику дальше" }).click();
  await expect(dialog.getByText("Включён облегчённый переход", { exact: true })).toHaveText("Включён облегчённый переход");
  await expect(dialog.locator(".chronicle-photo")).toHaveAttribute(
    "src",
    /chronicle-later/,
  );
  await expect(dialog.locator(".chronicle-transition")).toHaveCSS(
    "opacity",
    "0",
  );
  await expect(
    dialog.getByRole("button", { name: "Листать хронику дальше" }),
  ).toBeEnabled();
});

test("failed photo load is explicit after automatic retries, manual retry works and playback pauses", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  let fail = true;
  let requests = 0;
  await page.route("**/media/chronicle-early.png?variant=display", (route) => {
    requests++;
    return fail
      ? route.fulfill({ status: 503, body: "temporary" })
      : route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"/>',
        });
  });
  const dialog = await openPerson(page);
  await expect(dialog.getByRole("alert")).toHaveText(
    "Не удалось загрузить фотографию.Повторить",
  );
  expect(requests).toBe(3);
  fail = false;
  await dialog.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.locator(".chronicle-photo")).toHaveJSProperty(
    "naturalWidth",
    600,
  );
});

test("closing a chronicle cancels its delayed automatic photo retry", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  let requests = 0;
  await page.route("**/media/chronicle-early.png?variant=display", route => {
    requests++;
    return route.fulfill({ status: 503, body: "temporary" });
  });
  await page.goto('/people/e2e-child');
  await launchChronicle(page);
  const dialog = page.getByRole('dialog', { name: 'Семейная хроника', exact: true });
  await expect.poll(() => requests).toBe(1);
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Advance beyond the two backoff delays without starting another photo load.
  await page.waitForTimeout(800);
  expect(requests).toBe(1);
});

test("a failed background photo retries automatically without an error flash or losing the current frame", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  let requests = 0;
  await page.route("**/media/chronicle-later.png?variant=display", route => {
    requests++;
    return requests <= 2 ? route.fulfill({ status: 503, body: "temporary" }) : route.fulfill({
      contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"/>',
    });
  });
  const dialog = await openPerson(page);
  await expect.poll(() => requests).toBe(1);
  await page.evaluate(() => {
    const state = { errors: 0 };
    Object.assign(window, { chronicleRetry: state });
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes)
        if (node instanceof Element && (node.matches('[role="alert"]') || node.querySelector('[role="alert"]'))) state.errors++;
    }).observe(document.querySelector('.chronicle-stage')!, { childList: true, subtree: true });
  });
  await dialog.getByRole("button", { name: "Листать хронику дальше" }).click();
  await expect(dialog.locator('.chronicle-photo')).toHaveAttribute('src', /chronicle-early/);
  await expect(dialog.locator('.chronicle-photo')).toHaveAttribute('src', /chronicle-later/);
  await expect(dialog.getByRole("button", { name: "Листать хронику дальше" })).toBeEnabled();
  expect(requests).toBe(3);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { chronicleRetry: { errors: number } }).chronicleRetry.errors)).toBe(0);
});
test("person chronicle reads every page and never includes other people's or untagged photos", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const source = Array.from({ length: 34 }, (_, i) =>
    photo(`page-${i}`, String(1900 + i)),
  );
  source.push(
    { ...photo("untagged", "1800"), tags: [] },
    photo("someone-else", "1801", "e2e-spouse"),
  );
  await setup(page, source);
  const queries: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("projection=gallery"))
      queries.push(request.url());
  });
  const dialog = await openPerson(page);
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("1 / 34");
  await expect(dialog.locator(".chronicle-caption-summary")).toContainText("1900");
  expect(queries.length).toBeGreaterThan(1);
  expect(
    queries.every(
      (url) => new URL(url).searchParams.get("personId") === "e2e-child",
    ),
  ).toBe(true);
  await dialog.getByRole("button", { name: /^Снимок 34:/ }).click();
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("34 / 34");
  await expect(dialog.locator(".chronicle-caption-summary")).toContainText("1933");
  await page.screenshot({
    path: test.info().outputPath("chronicle-person.png"),
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("chronicle is a text-only action for a single selected person", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(
    page.getByRole("button", { name: "Хроника", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Хроника видимой ветви" }),
  ).toHaveCount(0);
  await page
    .locator('.flow-person[data-person-id="e2e-child"] .flow-person-content')
    .click();
  const launch = page.getByRole("button", { name: "Хроника", exact: true, includeHidden: true });
  await expect(launch).toHaveCount(1);
  await expect(launch.locator("svg")).toHaveCount(0);
  await expect(page.locator(".person-chronicle-button")).toHaveCount(0);
  await expect(page.locator(".tree-family-tools").getByRole("button", { name: "Хроника", exact: true, includeHidden: true })).toHaveCount(1);
  await launchChronicle(page);
  await expect(page.getByLabel("Номер снимка")).toHaveText("1 / 3");
});

test("named photo albums open only their own chronicle and retain the album on close", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await page.goto("/photos");
  await expect(page.getByRole("button", { name: "Хроника", exact: true })).toHaveCount(0);
  await page.locator('.photo-albums a[href$="/photos/e2e-child"]').click();
  await launchChronicle(page);
  const dialog = page.getByRole("dialog", { name: "Семейная хроника", exact: true });
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("1 / 3");
  await expect(dialog.locator(".chronicle-caption-summary")).toContainText("1950");
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(page).toHaveURL(/\/photos\/e2e-child$/);
  await expect(page.locator(".gallery-view")).toBeVisible();
  await page.goto("/photos/e2e-spouse");
  await expect(page.locator(".photo-grid .photo-tile")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Хроника", exact: true })).toHaveCount(0);
});

test("manual navigation keeps the old photo while loading and covers DOM decode before swapping layers", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await page.addInitScript(() => {
    const state = { pending: false, release: () => {} };
    (window as unknown as { chronicleDecode: typeof state }).chronicleDecode = state;
    const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await original.call(this);
      if (this.classList.contains("chronicle-photo") && this.src.includes("chronicle-later")) {
        await new Promise<void>(resolve => { state.pending = true; state.release = resolve; });
      }
    };
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/media/chronicle-later.png?variant=display", async route => {
    await gate;
    await route.fallback();
  });
  const dialog = await openPerson(page);
  await dialog.getByRole("button", { name: "Листать хронику дальше" }).click();
  const loader = dialog.locator(".chronicle-stage .chronicle-loading");
  await expect(loader).toBeVisible();
  await expect(loader).toHaveCSS("background-color", "rgba(0, 0, 0, 0.2)");
  await expect(dialog.locator(".chronicle-photo")).toHaveAttribute("src", /chronicle-early/);
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("1 / 3");
  release();
  await expect.poll(() => page.evaluate(() => (window as unknown as { chronicleDecode: { pending: boolean } }).chronicleDecode.pending)).toBe(true);
  await expect(dialog.locator(".chronicle-incoming")).toHaveCSS("opacity", "1");
  await expect(dialog.getByRole("button", { name: "Листать хронику дальше" })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { chronicleDecode: { release: () => void } }).chronicleDecode.release());
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("2 / 3");
  await expect(dialog.locator(".chronicle-incoming")).toHaveCSS("opacity", "0");
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("1 / 3");
  await expect(dialog.locator(".chronicle-photo")).toHaveAttribute("src", /chronicle-early/);
});

test("CodePen dot loader stays centered while person photos are being read", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/family?projection=gallery&**", async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto("/people/e2e-child");
  await launchChronicle(page);
  const loader = page.locator(".chronicle-loading");
  await expect(loader).toContainText("Собираем хронику");
  const box = (await loader.locator("canvas").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(
    2,
  );
  const alpha = await loader.locator("canvas").evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    return canvas
      .getContext("2d")!
      .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3];
  });
  expect(alpha).toBeGreaterThan(0);
  await page.screenshot({
    path: test.info().outputPath("chronicle-loading.png"),
  });
  release();
  await expect(loader).toHaveCount(0);
  await expect(page.getByLabel("Номер снимка")).toHaveText("1 / 3");
});

for (const count of [0, 1, 2]) {
  test(`chronicle needs at least two photos: ${count} person photos in the tree and named album`, async ({ page }) => {
    await setup(page, photos.slice(0, count));
    await page.goto("/people/e2e-child");
    await expect(page.getByRole("button", { name: "Открыть фотоальбом человека: " + count + " фото" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Хроника", exact: true, includeHidden: true })).toHaveCount(count > 1 ? 1 : 0);
    await page.goto("/photos/e2e-child");
    await expect(page.locator(".gallery-view")).toBeVisible();
    await expect(page.getByRole("button", { name: "Хроника", exact: true, includeHidden: true })).toHaveCount(count > 1 ? 1 : 0);
  });
}
test("chronicle launches from view modes after leaving mobile tree fullscreen and fills the viewport", async ({
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
  await expect(page.locator(".tree-mode-bar")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator(".tree-canvas.is-fullscreen")).toHaveCount(0);
  await page.goto("/people/e2e-child");
  await launchChronicle(page);
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
  await expect(page.getByRole("button", { name: "Хроника" })).toHaveCount(0);
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
test("Escape closes the chronicle and returns focus to its view menu", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const dialog = await openPerson(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.viewportSize()!.width < 600 ? page.locator(".tree-family-menu > summary") : page.getByRole("button", { name: "Хроника" })).toBeFocused();
});

test("photo progress freezes on pause and resumes from the same elapsed time", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const dialog = await openPerson(page);
  await page.clock.install({ time: new Date("2026-11-10T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-10T12:00:01Z"));
  await dialog.getByRole("button", { name: "Продолжить хронику" }).click();
  await page.clock.runFor(1750);
  const progress = dialog.getByRole("progressbar", {
    name: "Время показа снимка",
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "35");
  await dialog.getByRole("button", { name: "Приостановить хронику" }).click();
  await page.clock.runFor(10000);
  await expect(progress).toHaveAttribute("aria-valuenow", "35");
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("1 / 3");
  await dialog.getByRole("button", { name: "Продолжить хронику" }).click();
  await page.clock.runFor(3300);
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return dialog.getByLabel("Номер снимка").textContent();
  }).toBe("2 / 3");
});

test("photo details slide above the year and place and opening them pauses playback", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const dialog = await openPerson(page);
  const summary = dialog.locator(".chronicle-caption-summary");
  const details = dialog.getByRole("region", { name: "Сведения о фотографии", includeHidden: true });
  await expect(summary).toContainText("1950 · Москва");
  await expect(summary).not.toContainText("Семейная встреча");
  await expect(summary).not.toContainText("Описание");
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.locator(".chronicle-caption-drawer")).toHaveCSS("opacity", "0");
  await expect.poll(() => details.evaluate(node => node.getBoundingClientRect().height)).toBe(0);
  await page.clock.install();
  await dialog.getByRole("button", { name: "Продолжить хронику" }).click();
  await summary.click();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  await expect(details).toContainText("Семейная встреча");
  await expect(details).toContainText("Описание early");
  await expect(details).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Продолжить хронику" })).toBeVisible();
  const detailsBox = (await details.boundingBox())!;
  const summaryBox = (await summary.boundingBox())!;
  expect(detailsBox.y).toBeLessThan(summaryBox.y);
  await page.clock.fastForward(12000);
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("1 / 3");
  await page.screenshot({ path: test.info().outputPath("chronicle-details.png") });
  await summary.click();
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.locator(".chronicle-caption-drawer")).toHaveCSS("opacity", "0");
  await expect(dialog.getByRole("button", { name: "Приостановить хронику" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("chronicle-summary.png") });
});

test("only administrators can open H settings; saved configuration is reused by another viewer", async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const initial = await (await page.request.get("/api/chronicle-settings")).json();
  const other = await context.newPage();
  await page.bringToFront();
  try {
    const dialog = await openPerson(page);
    await page.keyboard.press("h");
    const panel = dialog.getByRole("complementary", { name: "Настройки хроники" });
    await expect(panel).toBeVisible();
    await panel.getByLabel("Переход", { exact: true }).selectOption("ripple");
    await panel.getByLabel("Пресет", { exact: true }).selectOption("Strong");
    await panel.getByRole("button", { name: "Свернуть настройки хроники" }).click();
    await expect(panel.getByLabel("Переход", { exact: true })).toBeHidden();
    expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(32);
    await page.screenshot({ path: test.info().outputPath("chronicle-settings-collapsed.png") });
    await panel.getByRole("button", { name: "Развернуть настройки хроники" }).click();
    await expect(panel.getByLabel("Пресет", { exact: true })).toHaveValue("Strong");
    await panel.getByRole("slider", { name: "Время показа, мс", exact: true }).press("Home");
    await panel.getByRole("slider", { name: "Длительность перехода, с", exact: true }).press("Home");
    await panel.getByRole("button", { name: "Сохранить для всех" }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Сохранено для всех древ" })).toHaveText("Сохранено для всех древ");
    const saved = await (await page.request.get("/api/chronicle-settings")).json();
    expect(saved.settings).toMatchObject({ currentEffect: "ripple", autoSlideSpeed: 2000, transitionDuration: 0.5, rippleFrequency: 35 });
    await panel.getByRole("button", { name: "Закрыть настройки" }).click();
    await expect(panel).toHaveCount(0);
    await setup(other);
    await other.emulateMedia({ reducedMotion: "reduce" });
    await other.bringToFront();
    let reads = 0;
    await other.route("**/api/chronicle-settings", async route => {
      reads++;
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), canConfigure: false } });
    });
    const viewer = await openPerson(other);
    await other.keyboard.press("h");
    await expect(viewer.getByRole("complementary", { name: "Настройки хроники" })).toHaveCount(0);
    expect(reads).toBe(1);
    await other.clock.install();
    await viewer.getByRole("button", { name: "Продолжить хронику" }).click();
    await other.clock.fastForward(2100);
    await expect.poll(async () => { await other.clock.runFor(50); return viewer.getByLabel("Номер снимка").textContent(); }).toBe("2 / 3");
    await page.bringToFront();
    await page.keyboard.press("h");
    await expect(panel.getByLabel("Переход", { exact: true })).toHaveValue("ripple");
    await page.screenshot({ path: test.info().outputPath("chronicle-admin-settings.png") });
  } finally {
    await other.close();
    const latest = await (await page.request.get("/api/chronicle-settings")).json();
    const restored = await page.request.put("/api/chronicle-settings", { data: { version: latest.version, settings: initial.settings } });
    expect(restored.status()).toBe(200);
  }
});

test("H settings keep an unsaved draft on version conflict and refresh permission before reopening", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const dialog = await openPerson(page);
  await page.keyboard.press("h");
  const panel = dialog.getByRole("complementary", { name: "Настройки хроники" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Переход", { exact: true }).selectOption("timeshift");
  await page.route("**/api/chronicle-settings", async route => {
    if (route.request().method() === "PUT") return route.fulfill({ status: 409, json: { error: "Настройки изменены другим администратором" } });
    await route.fallback();
  });
  await panel.getByRole("button", { name: "Сохранить для всех" }).click();
  await expect(panel.getByRole("alert")).toContainText("другим администратором");
  await expect(panel.getByLabel("Переход", { exact: true })).toHaveValue("timeshift");
  await panel.getByRole("button", { name: "Закрыть настройки" }).click();
  await page.route("**/api/chronicle-settings", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), canConfigure: false } });
  });
  await page.keyboard.press("h");
  await expect(panel).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

test("all five reference shaders render their configured effect with exact photo endpoints", async ({ page }) => {
  test.setTimeout(120000);
  await setup(page);
  let effect: ChronicleEffect = "glass";
  await page.route("**/api/chronicle-settings", route => route.fulfill({ json: { version: 1, canConfigure: false,
    settings: { ...defaultChronicleSettings, ...chroniclePresets[effect].Default, currentEffect: effect, transitionDuration: 0.5 } } }));
  await page.addInitScript(() => {
    const frames: Array<{ effect: number; progress: number }> = [];
    (window as unknown as { effectFrames: typeof frames }).effectFrames = frames;
    const original = WebGLRenderingContext.prototype.drawArrays;
    WebGLRenderingContext.prototype.drawArrays = function (...args) {
      original.apply(this, args);
      if (!(this.canvas instanceof HTMLCanvasElement) || !this.canvas.closest(".chronicle-stage")) return;
      const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram;
      frames.push({ effect: this.getUniform(program, this.getUniformLocation(program, "uEffectType")!) as number,
        progress: this.getUniform(program, this.getUniformLocation(program, "uProgress")!) as number });
    };
  });
  // Install the virtual clock once: reinstalling it on the next photo/effect
  // keeps its advanced time, so pauseAt() cannot move back to the original date.
  const animationTime = new Date("2026-11-11T12:00:00Z");
  await page.clock.install({ time: animationTime });
  for (const [index, name] of Object.keys(chronicleEffects).entries()) {
    effect = name as ChronicleEffect;
    const dialog = await openPerson(page);
    await dialog.getByRole("button", { name: "Приостановить хронику" }).click();
    // Software WebGL can take longer than the entire transition to draw a
    // frame. Advance the animation clock explicitly so every shader is tested
    // at intermediate progress rather than depending on the runner's GPU/FPS.
    // Each effect gets a strictly later clock instant, even after navigation.
    await page.clock.pauseAt(new Date(animationTime.getTime() + (index + 1) * 60_000));
    await dialog.getByRole("button", { name: "Листать хронику дальше" }).click();
    await expect(dialog.locator(".chronicle-transition")).toHaveCSS("opacity", "1");
    // Sample intermediate GPU frames, then skip the remaining delay: software
    // WebGL can be too slow to render every frame before a wall-clock timeout.
    await page.clock.runFor(100);
    const frames = await page.evaluate(() => (window as unknown as { effectFrames: Array<{ effect: number; progress: number }> }).effectFrames);
    expect(frames.some(frame => frame.effect === index && frame.progress === 0), name).toBe(true);
    expect(frames.some(frame => frame.effect === index && frame.progress > 0 && frame.progress < 1), name).toBe(true);
    await page.clock.fastForward(650);
    await page.clock.runFor(50);
    await expect(dialog.getByRole("button", { name: "Листать хронику дальше" })).toBeEnabled({ timeout: 20000 });
    await expect(dialog.getByLabel("Номер снимка")).toHaveText("2 / 3");
    await expect(dialog.locator(".chronicle-photo")).toHaveAttribute("src", /chronicle-later/);
    await expect(dialog.locator(".chronicle-transition")).toHaveCSS("opacity", "0");
    await page.clock.resume();
  }
});

test("adjacent display photos preload during dwell and transfer without another request or loading flash", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const display: string[] = [];
  page.on("request", request => { if (request.url().includes("/media/chronicle-") && request.url().includes("variant=display")) display.push(request.url()); });
  await page.addInitScript(() => {
    const ready: string[] = [];
    (window as unknown as { warmedPhotos: string[] }).warmedPhotos = ready;
    const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () { await original.call(this); if (this.src.includes("variant=display")) ready.push(this.src); };
  });
  const dialog = await openPerson(page);
  await expect.poll(() => page.evaluate(() => {
    const urls = (window as unknown as { warmedPhotos: string[] }).warmedPhotos;
    return urls.some(url => url.includes("chronicle-later")) && urls.some(url => url.includes("chronicle-unknown"));
  })).toBe(true);
  expect(display.filter(url => url.includes("chronicle-later"))).toHaveLength(1);
  await page.route("**/media/chronicle-later.png?variant=display", route => route.fulfill({ status: 503, body: "must use preloaded image" }));
  await page.evaluate(() => {
    const state = { flashes: 0 };
    (window as unknown as { preloadNavigation: typeof state }).preloadNavigation = state;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes)
        if (node instanceof Element && node.matches(".chronicle-loading")) state.flashes++;
    }).observe(document.querySelector(".chronicle-stage")!, { childList: true });
  });
  await dialog.getByRole("button", { name: "Листать хронику дальше" }).click();
  await expect(dialog.getByRole("button", { name: "Листать хронику дальше" })).toBeEnabled();
  await expect(dialog.getByLabel("Номер снимка")).toHaveText("2 / 3");
  expect(display.filter(url => url.includes("chronicle-later"))).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { preloadNavigation: { flashes: number } }).preloadNavigation.flashes)).toBe(0);
});

test("new photo metadata appears with its incoming layer while the final image is still decoding", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await page.addInitScript(() => {
    const state = { waiting: false, release: () => {} };
    (window as unknown as { finalPhotoDecode: typeof state }).finalPhotoDecode = state;
    const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await original.call(this);
      if (this.classList.contains("chronicle-photo") && this.src.includes("chronicle-later"))
        await new Promise<void>(resolve => { state.waiting = true; state.release = resolve; });
    };
  });
  const dialog = await openPerson(page);
  await dialog.getByRole("button", { name: "Листать хронику дальше" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { finalPhotoDecode: { waiting: boolean } }).finalPhotoDecode.waiting)).toBe(true);
  await expect(dialog.locator(".chronicle-incoming")).toHaveCSS("opacity", "1");
  await expect(dialog.locator(".chronicle-caption-summary")).toHaveText("1980 · Москва");
  await expect(dialog.getByRole("button", { name: "Листать хронику дальше" })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { finalPhotoDecode: { release: () => void } }).finalPhotoDecode.release());
  await expect(dialog.getByRole("button", { name: "Листать хронику дальше" })).toBeEnabled();
});

test("a cold jump across several photos shows loading over the current photo until the selected one is ready", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page, Array.from({ length: 8 }, (_, index) => photo(`jump-${index}`, String(1900 + index))));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/media/chronicle-jump-5.png?variant=display", async route => { await gate; await route.fallback(); });
  const dialog = await openPerson(page);
  await dialog.getByRole("button", { name: /^Снимок 6:/ }).click();
  await expect(dialog.locator(".chronicle-stage .chronicle-loading")).toBeVisible();
  await expect(dialog.locator(".chronicle-caption-summary")).toHaveText("1900 · Москва");
  await expect(dialog.locator(".chronicle-photo")).toHaveAttribute("src", /chronicle-jump-0/);
  release();
  await expect(dialog.locator(".chronicle-caption-summary")).toHaveText("1905 · Москва");
  await expect(dialog.getByRole("button", { name: "Листать хронику дальше" })).toBeEnabled();
  await expect(dialog.locator(".chronicle-loading")).toHaveCount(0);
});
