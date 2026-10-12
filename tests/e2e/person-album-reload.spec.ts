import { expect, test } from "@playwright/test";
import { archiveOverview, personDetails } from "../../src/domain/archive-projection.ts";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

test("the open profile refreshes its real album total after a minimal write without selecting it again", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "person editing is a desktop interaction");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const initialResponse = await page.request.get("/api/family?projection=overview");
  const initial = await initialResponse.json();
  let family = (await (await page.request.get("/api/family")).json()).family as Family;
  let revision = initial.revision as number;
  let saved = false;
  const detailsRequests: Array<{ revision: number; ids: string[] }> = [];
  const photoUrl = "/media/album-reload-preview.png";
  await page.route("**/media/album-reload-preview*", route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XG18AAAAASUVORK5CYII=", "base64") }));
  const photo = (index: number) => ({ id: `preview-photo-${index}`, title: `Фото ${index}`, url: photoUrl, tags: [{ id: `preview-tag-${index}`, personId: "e2e-child", x: 0, y: 0, width: 1, height: 1 }] });
  family.photos = Array.from({ length: 41 }, (_, index) => photo(index));
  const token = () => initial.pageToken.replace(/^\d+:/, `${revision}:`);
  await page.route("**/api/family?projection=overview", route => route.fulfill({ response: initialResponse, json: { ...initial, family: archiveOverview(family), revision, pageToken: token(), partial: true, totals: { people: family.people.length, photos: family.photos!.length } } }));
  await page.route("**/api/family?projection=details*", route => {
    const params = new URL(route.request().url()).searchParams;
    const ids = JSON.parse(params.get("ids")!) as string[];
    expect(params.get("token")).toBe(token());
    expect(params.get("preview")).toBe("1");
    detailsRequests.push({ revision, ids });
    const available = family.photos!.filter(photo => photo.tags.some(tag => ids.includes(tag.personId)));
    return route.fulfill({ json: { pageToken: token(), people: family.people.filter(person => ids.includes(person.id)).map(personDetails), photos: available.slice(0, 30), photoTotal: available.length, personPhotoTotals: Object.fromEntries(ids.map(id => [id, family.photos!.filter(photo => photo.tags.some(tag => tag.personId === id)).length])) } });
  });
  await page.route("**/api/family/changes", route => {
    expect(route.request().headers().prefer).toBe("return=minimal");
    const changes = route.request().postDataJSON().changes as Change[];
    const applied = applyArchiveChanges(family, changes);
    expect(applied.conflicts).toEqual([]);
    family = applied.family;
    // A new archive revision may also include another user's album update.
    family.photos!.push(photo(41));
    revision++;
    saved = true;
    return route.fulfill({ json: { revision, appliedChanges: changes } });
  });
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  const inspector = page.getByRole("complementary", { name: "Выбранный объект" });
  const album = inspector.locator(".person-album-stack");
  await expect(album).toHaveAttribute("aria-label", "Открыть фотоальбом человека: 41 фото");
  const initialDetailCount = detailsRequests.filter(request => request.ids.includes("e2e-child")).length;
  const selectedUrl = page.url();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  const form = page.locator(".person-editor-form");
  await form.locator('input[data-field="name"]').fill("Тестов Александр Иванович");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => saved).toBe(true);
  await expect(form).toHaveCount(0);
  await expect(page).toHaveURL(selectedUrl);
  await expect(inspector.getByRole("heading", { level: 2 })).toHaveText(/Тестов\s*Александр\s*Иванович/);
  await expect(album).toHaveAttribute("aria-label", "Открыть фотоальбом человека: 42 фото");
  expect(detailsRequests.filter(request => request.ids.includes("e2e-child")).length).toBe(initialDetailCount + 1);
  expect(detailsRequests.at(-1)!.revision).toBe(revision);
  // A normal rerender must reuse the fresh preview, rather than starting a loop.
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const preferences = page.getByRole("dialog", { name: "Вид древа" });
  await preferences.getByRole("button", { name: "Закрыть" }).click();
  await expect(album).toHaveAttribute("aria-label", "Открыть фотоальбом человека: 42 фото");
  expect(detailsRequests.filter(request => request.ids.includes("e2e-child")).length).toBe(initialDetailCount + 1);
});
