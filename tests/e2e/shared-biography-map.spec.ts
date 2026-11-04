import { expect, test } from "@playwright/test";
import { biographyMapBlock } from "../../src/domain/biography-map.ts";
import { sharedFamily } from "../../src/domain/shared-family.ts";
import type { Family } from "../../src/domain/types.ts";

test("shared biography opens on the tree canvas and clears on content change or revoked access", async ({ page, request, isMobile }) => {
  const family = (await (await request.get("/api/family")).json()).family as Family;
  const person = family.people.find(p => p.id === "e2e-child")!;
  const biography = biographyMapBlock({ type: "FeatureCollection", name: "Общий маршрут", features: [
    { type: "Feature", properties: { name: "Начало пути" }, geometry: { type: "Point", coordinates: [30, 50] } },
  ] });
  person.biography = biography;
  const token = "J".repeat(43);
  const projection = sharedFamily(family, { id: "map-share", title: "Общее древо", anchorId: person.id,
    personIds: [person.id], createdAt: "2026-01-01", expiresAt: "2027-01-01", createdBy: "owner",
    createdName: "Владелец", revokedAt: null, lastVisitedAt: null }, token);
  let revoked = false;
  await page.route(new RegExp(`/api/shared/${token}(?:\\?.*)?$`), route => revoked
    ? route.fulfill({ status: 404, json: { error: "Ссылка недоступна" } })
    : route.fulfill({ json: { family: projection, anchorId: person.id, serverTime: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }));
  await page.route("https://tile.openstreetmap.org/**", route => route.fulfill({ status: 204, body: "" }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/s/${token}`);
  await expect(page.locator(".tree-canvas")).toHaveAttribute("data-camera-ready", "true");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  const dock = page.locator(".inspector-dock");
  const mini = dock.getByRole("button", { name: "Открыть карту: Общий маршрут" });
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  const transform = await page.locator(".react-flow__viewport").getAttribute("style");
  await mini.click();
  await expect(workspace).toBeVisible();
  await expect(page.locator(".biography-map-preview-dialog")).toHaveCount(0);
  await expect(page.locator(".tree-scene")).toHaveAttribute("inert", "");
  await expect(dock).toBeVisible();
  if (isMobile) {
    await expect(dock).toHaveClass(/is-map-peek/);
    expect((await dock.boundingBox())!.height).toBeLessThan(75);
    await expect(workspace.locator("header h2")).toBeHidden();
  } else {
    const mapBox = (await workspace.boundingBox())!, dockBox = (await dock.boundingBox())!;
    expect(mapBox.x + mapBox.width).toBeLessThanOrEqual(dockBox.x + 2);
    await expect(dock.getByRole("tab", { name: "О человеке", exact: true })).toBeVisible();
  }
  await workspace.getByRole("button", { name: "Вернуться к древу" }).click();
  await expect(workspace).toHaveCount(0);
  await expect(page.locator(".tree-scene")).not.toHaveAttribute("inert");
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", transform!);
  await mini.click();
  await expect(workspace).toBeVisible();
  projection.people[0].biography = "";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(workspace).toHaveCount(0);
  await expect(mini).toHaveCount(0);
  projection.people[0].biography = biography;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(mini).toBeVisible();
  await expect(workspace).toHaveCount(0);
  await mini.click();
  await expect(workspace).toBeVisible();
  revoked = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("heading", { name: "Ссылка недоступна" })).toBeVisible();
  await expect(workspace).toHaveCount(0);
  await expect(dock).toHaveCount(0);
});
