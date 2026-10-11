import type { Page } from "@playwright/test";
import type { ArchivePhoto } from "../../src/domain/types";
import {
  galleryProjection,
  type GalleryQuery,
} from "../../src/domain/archive-view-projection";

/** Mirror the real paged contract; retain legacy collection mocks for explicit full reads. */
export async function pagedPhotoFixture(page: Page, photos: ArchivePhoto[]) {
  const { family } = await (
    await page.request.get("/api/family?projection=overview")
  ).json();
  await page.route("**/api/family?projection=gallery&**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: {
        pageToken: params.get("token"),
        ...galleryProjection(
          { ...family, photos },
          {
            mode: params.get("mode") as GalleryQuery["mode"],
            personId: params.get("personId"),
            year: params.get("year"),
            offset: Number(params.get("offset")),
          },
        ),
      },
    });
  });
  await page.route("**/api/family?projection=photos&**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const ids = JSON.parse(params.get("ids")!) as string[];
    const selected = photos.filter((photo) => ids.includes(photo.id));
    return route.fulfill({
      status: selected.length === ids.length ? 200 : 404,
      json: { pageToken: params.get("token"), photos: selected },
    });
  });
}
