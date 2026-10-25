import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pagedPhotoFixture } from "./paged-photo-fixture";

for (const sample of ["blank", "face"] as const)
  test(`the modular face runtime runs real ${sample} inference`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== "desktop");
    test.setTimeout(90_000);
    const errors: string[] = [];
    const models = new Set<string>();
    const descriptors: number[][] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (
        response.ok() &&
        /\/models\/human-3\.3\.6\/.+\.(json|bin)$/.test(response.url())
      )
        models.add(new URL(response.url()).pathname.split("/").pop()!);
    });
    const photo = {
      id: `face-runtime-${sample}`,
      title: "Тест модели",
      url: `/media/face-runtime-${sample}.png`,
      year: "2000",
      tags: [],
    };
    await page.route("**/api/faces/status", (route) =>
      route.fulfill({ json: { enabled: true } }),
    );
    await page.route("**/api/faces/match", (route) => {
      descriptors.push(route.request().postDataJSON().descriptor);
      return route.fulfill({ json: { match: null } });
    });
    await page.route("**/api/family?projection=overview", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.family.photos = [photo];
      data.totals.photos = 1;
      await route.fulfill({ response, json: data });
    });
    await page.route(`**/media/face-runtime-${sample}.png**`, (route) =>
      route.fulfill(
        sample === "blank"
          ? {
              contentType: "image/svg+xml",
              body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="white"/></svg>',
            }
          : {
              // Public demo image distributed with the pinned Human package; no user photos.
              contentType: "image/jpeg",
              body: readFileSync(
                resolve(
                  "node_modules/@vladmandic/human/assets/screenshot-faceid.jpg",
                ),
              ),
            },
      ),
    );
    await pagedPhotoFixture(page, [photo]);
    await page.goto(`/photos/face-runtime-${sample}`);
    await page
      .getByRole("group", { name: "Действия с фотографией" })
      .getByRole("button", { name: "Редактировать", exact: true })
      .click();
    // An untagged image starts the real detector automatically in edit mode.
    await expect(page.locator(".photo-scan-status")).toContainText(
      sample === "blank" ? "Новых лиц не найдено" : /Найдено лиц: [1-9]/,
      { timeout: 60_000 },
    );
    for (const model of ["blazeface", "facemesh", "faceres"])
      expect(
        models.has(`${model}.json`),
        `real ${model} model was fetched`,
      ).toBe(true);
    if (sample === "face") {
      expect(descriptors.length).toBeGreaterThan(0);
      for (const descriptor of descriptors) {
        expect(descriptor).toHaveLength(1024);
        expect(descriptor.every(Number.isFinite)).toBe(true);
      }
    } else expect(descriptors).toEqual([]);
    expect(errors).toEqual([]);
  });
