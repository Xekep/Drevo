import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

for (const variant of ["portrait", "classic"] as const)
  test(`${variant} tree downloads a standalone vector SVG of the visible graph`, async ({
    page,
    context,
    isMobile,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const data = await (await page.request.get("/api/family")).json();
    data.family.people.find(
      (person: { id: string }) => person.id === "e2e-child",
    ).photo = "/media/svg-portrait.png";
    data.family.people.find(
      (person: { id: string }) => person.id === "e2e-sibling-child",
    ).name = "<script>alert(1)</script>";
    const photo = await sharp({
      create: { width: 90, height: 90, channels: 3, background: "#31779a" },
    }).png().toBuffer();
    await context.route("**/media/svg-portrait.png**", (route) =>
      route.fulfill({ contentType: "image/png", body: photo }),
    );
    const token = "s".repeat(43);
    await page.route(`**/api/shared/${token}`, (route) =>
      route.fulfill({
        json: {
          family: data.family,
          reverseTimeline: false,
          serverTime: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
    );
    await page.addInitScript(
      (cardVariant) => localStorage.setItem(
        "drevo:guest-tree-preferences:v1",
        JSON.stringify({ reverseTimeline: false, cardVariant, colorScheme: "white" }),
      ),
      variant,
    );
    await page.goto(`/s/${token}`);
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-grow|is-layout-settling/,
    );
    await expect(page.locator('.flow-person[data-person-id="e2e-child"]').first()).toBeVisible();
    await expect.poll(() => page.locator(".react-flow__edge").count()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Настройки древа" }).click();
    const dialog = page.getByRole("dialog", { name: "Вид древа" });
    await expect(dialog).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Сохранить древо в SVG" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Скачивание SVG началось.");
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.svg$/);
    const contents = await readFile((await download.path())!, "utf8");
    if (variant === "portrait" && !isMobile) {
      await writeFile(testInfo.outputPath("tree.svg"), contents);
      await sharp(Buffer.from(contents)).resize({ width: 1400 }).png()
        .toFile(testInfo.outputPath("tree.png"));
    }
    const graph = await page.evaluate((xml) => {
      const doc = new DOMParser().parseFromString(xml, "image/svg+xml");
      return {
        malformed: !!doc.querySelector("parsererror"),
        people: [...doc.querySelectorAll("g[data-person-id]")]
          .map((node) => node.getAttribute("data-person-id")),
        paths: doc.querySelectorAll("path[stroke]").length,
        embeddedPhoto: [...doc.querySelectorAll("image")]
          .some((image) => image.getAttribute("href")?.startsWith("data:image/")),
        foreignObjects: doc.querySelectorAll("foreignObject, script").length,
        text: doc.documentElement.textContent || "",
        background: doc.querySelector("svg > rect")?.getAttribute("fill"),
      };
    }, contents);
    expect(graph.malformed).toBe(false);
    expect(new Set(graph.people)).toEqual(
      new Set(data.family.people.map((person: { id: string }) => person.id)),
    );
    expect(graph.paths).toBeGreaterThan(0);
    expect(graph.embeddedPhoto).toBe(true);
    expect(graph.foreignObjects).toBe(0);
    expect(graph.text).toContain("Пётр");
    expect(graph.text).toContain("<script>alert(1)");
    expect(graph.background).toBe("#fff");
  });

test("SVG omits a collapsed descendant and keeps the rest of the tree", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  await page.getByTestId("rf__node-e2e-child")
    .getByRole("button", { name: /Свернуть (потомков|ветвь)/ }).click();
  await expect(page.getByTestId("rf__node-e2e-grandchild")).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-layout-settling/);
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Сохранить древо в SVG" }).click();
  const download = await downloadPromise;
  const contents = await readFile((await download.path())!, "utf8");
  expect(contents).not.toContain('data-person-id="e2e-grandchild"');
  expect(contents).toContain('data-person-id="e2e-child"');
});
