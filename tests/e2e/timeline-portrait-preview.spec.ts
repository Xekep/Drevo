import { expect, test } from "@playwright/test";
import sharp from "sharp";

for (const kind of ["archive", "shared"] as const) {
  test(`chronology uses a compact colour portrait from ${kind} media`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const photo =
      kind === "archive"
        ? "/media/timeline-avatar.jpg"
        : `/api/shared/${"a".repeat(43)}/portrait/timeline-person`;
    const source = sharp({
      create: {
        width: 400,
        height: 400,
        channels: 3,
        background: { r: 180, g: 70, b: 35 },
      },
    });
    const thumb = await source.clone().webp().toBuffer();
    const avatar = await source.clone().resize(128, 128).webp().toBuffer();
    await page.route(`**${photo}*`, async (route) => {
      const variant = new URL(route.request().url()).searchParams.get(
        "variant",
      );
      await route.fulfill({
        contentType: "image/webp",
        body: variant === "avatar" ? avatar : thumb,
      });
    });
    await page.route("**/api/family?projection=overview", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.family.people = [
        {
          ...data.family.people[0],
          id: "timeline-person",
          name: "Портрет",
          surname: "Тестов",
          photo,
          birth: "1940-01-01",
          parents: [],
          spouses: [],
          generation: 1,
          column: 0,
        },
      ];
      data.family.links = [];
      data.family.unions = [];
      data.family.photos = [];
      data.partial = false;
      data.user.personId = null;
      await route.fulfill({ response, json: data });
    });
    await page.goto("/tree");
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-grow|is-layout-settling/,
    );
    await page
      .getByRole("button", { name: "Хронология", exact: true })
      .or(page.getByRole("switch", { name: "Древо / Хронология" }))
      .click();
    const portrait = page.locator(
      '.horizontal-timeline [data-person-id="timeline-person"] .person-avatar img',
    );
    await expect(portrait).toHaveAttribute("src", `${photo}?variant=avatar`);
    await expect
      .poll(() =>
        portrait.evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(128);
    await expect(portrait).toBeVisible();
  });
}
