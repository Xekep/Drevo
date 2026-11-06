import { expect, test, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { biographyMapBlock } from "../../src/domain/biography-map.ts";
import type { Family } from "../../src/domain/types.ts";

async function expectNativeTiles(page: Page, surface: Locator, value: number) {
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
  const tiles = await surface.locator("img.leaflet-tile").evaluateAll(images =>
    images.map(image => {
      const rect = image.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        nativeWidth: (image as HTMLImageElement).width, nativeHeight: (image as HTMLImageElement).height };
    }));
  expect(tiles.every(tile => tile.nativeWidth === 256 && tile.nativeHeight === 256)).toBe(true);
  // A one-pixel road near the tile's right edge must stay at its source coordinate.
  // Stretching 256px to 258px moves this road by almost two CSS pixels.
  let probes = 0;
  for (const tile of tiles) {
    const px = tile.x + 240.5 * tile.width / 256;
    for (const row of [40.5, 72.5, 104.5, 136.5, 168.5, 200.5, 232.5]) {
      const py = tile.y + row * tile.height / 256;
      if (px < x + 2 || px >= x + width - 2 || py < y + 2 || py >= y + height - 2) continue;
      const ix = Math.floor((px - x) * info.width / width);
      const iy = Math.floor((py - y) * info.height / height);
      const samples: number[] = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          samples.push(data[((iy + dy) * info.width + ix + dx) * info.channels]);
      const sample = value === 48 ? Math.max(...samples) : Math.min(...samples);
      expect(Math.abs(sample - (272 - value))).toBeLessThan(100);
      probes++;
    }
  }
  expect(probes).toBeGreaterThan(0);

}

for (const value of [48, 224]) {
  test(`biography tiles preserve ${value === 48 ? "dark" : "light"} map details without stretching at fractional page scale`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const pixels = Buffer.alloc(256 * 256 * 3);
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++)
        pixels.fill(x % 16 === 0 || y % 16 === 0 ? 272 - value : value,
          (y * 256 + x) * 3, (y * 256 + x + 1) * 3);
    const tile = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
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
      await expectNativeTiles(page, mini, value);
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
      await expectNativeTiles(page, surface, value);
      await surface.locator(".leaflet-control-zoom-in").click();
      await expectNativeTiles(page, surface, value);
    }
  });
}
