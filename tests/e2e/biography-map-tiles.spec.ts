import { expect, test, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { biographyMapBlock } from "../../src/domain/biography-map.ts";
import type { Family } from "../../src/domain/types.ts";

async function expectSolidTiles(page: Page, surface: Locator, value: number) {
  await surface.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      surface
        .locator("img.leaflet-tile")
        .evaluateAll(
          (tiles) =>
            tiles.length > 0 &&
            tiles.every(
              (tile) =>
                tile instanceof HTMLImageElement &&
                tile.complete &&
                tile.naturalWidth === 256 &&
                tile.classList.contains("leaflet-tile-loaded") &&
                getComputedStyle(tile).opacity === "1",
            ),
        ),
    )
    .toBe(true);
  const box = (await surface.boundingBox())!,
    viewport = page.viewportSize()!;
  const x = Math.max(0, box.x) + 12,
    y = Math.max(0, box.y) + 12;
  const width = Math.min(viewport.width, box.x + box.width) - x - 12;
  const height = Math.min(viewport.height, box.y + box.height) - y - 12;
  expect(width).toBeGreaterThan(100);
  expect(height).toBeGreaterThan(100);
  const png = await page.screenshot({
    path: test.info().outputPath("tile-pixels.png"),
    clip: { x, y, width, height },
  });
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let seams = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (
      Math.abs(data[i] - value) > 3 ||
      Math.abs(data[i + 1] - value) > 3 ||
      Math.abs(data[i + 2] - value) > 3
    )
      seams++;
  if (seams) {
    await test
      .info()
      .attach("tile-pixels", { body: png, contentType: "image/png" });
  }
  expect(
    seams,
    "uniform tiles must not acquire bright or dark boundary lines",
  ).toBe(0);
}

for (const value of [48, 224]) {
  test(`biography tiles keep their ${value === 48 ? "dark" : "light"} edges at fractional page scale`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const tile = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 3,
        background: { r: value, g: value, b: value },
      },
    })
      .png()
      .toBuffer();
    await page.route("https://tile.openstreetmap.org/**", (route) =>
      route.fulfill({ contentType: "image/png", body: tile }),
    );
    const family = (await (await page.request.get("/api/family")).json())
      .family as Family;
    const person = family.people.find((p) => p.id === "e2e-child")!;
    person.parents = [];
    person.spouses = [];
    person.photo = undefined;
    person.biography = biographyMapBlock({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Место" },
          geometry: { type: "Point", coordinates: [37, 53] },
        },
      ],
    });
    const token = "T".repeat(43);
    await page.route(`**/api/shared/${token}`, (route) =>
      route.fulfill({
        json: {
          family: { ...family, people: [person], links: [], unions: [] },
          serverTime: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
    );
    await page.goto(`/s/${token}`);
    await expect(page.locator(".tree-canvas")).toHaveAttribute(
      "data-camera-ready",
      "true",
    );
    await page
      .getByTestId("rf__node-e2e-child")
      .locator(".flow-person-content")
      .click();
    // Keep the real layout and tile compositor; exclude vector/HTML controls
    // from the pixel check. CSS zoom deliberately forces fractional tile edges.
    await page.addStyleTag({
      content:
        ".biography-map-mini .leaflet-marker-pane,.biography-map-mini .leaflet-shadow-pane,.biography-map-mini .leaflet-control-container,.biography-map-surface .leaflet-marker-pane,.biography-map-surface .leaflet-shadow-pane,.biography-map-surface .leaflet-control-container,.biography-map-points-list{opacity:0!important}",
    });
    const mini = page.locator(".inspector-dock .biography-map-mini");
    for (const zoom of [0.9, 1, 1.1, 1.25]) {
      await page.evaluate((scale) => {
        document.documentElement.style.zoom = String(scale);
      }, zoom);
      await expectSolidTiles(page, mini, value);
    }
    await mini.click();
    await page.addStyleTag({
      content:
        ".biography-map-workspace > header, .inspector-dock {opacity:0!important}",
    });
    const surface = page.locator(
      ".biography-map-workspace .biography-map-surface",
    );
    for (const zoom of [0.9, 1, 1.1, 1.25]) {
      await page.evaluate((scale) => {
        document.documentElement.style.zoom = String(scale);
      }, zoom);
      await expectSolidTiles(page, surface, value);
      await surface.locator(".leaflet-control-zoom-in").click();
      await expectSolidTiles(page, surface, value);
    }
  });
}
