import { expect, test } from "@playwright/test";
import type { Family } from "../../src/domain/types.ts";

test("startup recovers when a page token is invalidated by another editor", async ({
  page,
}) => {
  let invalidated = false,
    snapshots = 0;
  await page.route("**/api/family**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.search) snapshots++;
    if (!invalidated && url.searchParams.get("projection") === "page") {
      invalidated = true;
      await route.fulfill({
        status: 409,
        json: { error: "Changed concurrently" },
      });
    } else await route.continue();
  });
  await page.goto("/tree");
  await expect(page.getByTestId("rf__node-e2e-child")).toBeVisible();
  await expect.poll(() => snapshots).toBe(1);
  await expect(
    page.getByRole("heading", { name: "Не удалось открыть архив" }),
  ).toHaveCount(0);
});

test("card editor accepts minimal replies and preserves an independent concurrent edit", async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== "desktop");
  const initial = await (await request.get("/api/family")).json();
  const ids = ["e2e-child", "e2e-spouse"];
  const original = (initial.family as Family).people.filter((p) =>
    ids.includes(p.id),
  );
  const edit = async (text: string) => {
    await page.locator(".inspector-person-actions .person-edit-button").click();
    await page.getByText("Жизнь и занятия", { exact: true }).click();
    await page.getByRole("textbox", { name: "История человека" }).fill(text);
  };
  const save = async () => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/family/changes") &&
        r.request().method() === "POST",
    ).then(async (saved) => {
      expect(saved.status()).toBe(200);
      // Consume the body as soon as the response arrives. Closing the editor
      // may navigate before a later CDP body lookup can retrieve it.
      return saved.json();
    });
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    const saved = await response;
    await expect(
      page.getByRole("heading", { name: "Редактировать человека" }),
    ).toHaveCount(0);
    return saved;
  };
  try {
    await page.goto("/tree");
    await page
      .getByTestId("rf__node-e2e-child")
      .locator(".flow-person-content")
      .click();
    await edit("Локальная проверка сохранения");
    const first = await save();
    expect(first.family).toBeUndefined();
    expect(
      first.appliedChanges.some(
        (c: { field: string }) => c.field === "biography",
      ),
    ).toBe(true);
    await edit("Вторая локальная запись");
    const remote = await request.post("/api/family/changes", {
      headers: { "If-Match": String(first.revision) },
      data: {
        changes: [
          {
            collection: "people",
            id: "e2e-spouse",
            field: "biography",
            before: original.find((p) => p.id === "e2e-spouse")?.biography,
            after: "Независимая вкладка",
          },
        ],
      },
    });
    expect(remote.status()).toBe(200);
    const second = await save();
    expect(
      second.family.people.find((p: { id: string }) => p.id === "e2e-spouse")
        .biography,
    ).toBe("Независимая вкладка");
    expect(
      second.appliedChanges.every((c: { id: string }) => c.id === "e2e-child"),
    ).toBe(true);
    await page.reload();
    await page
      .getByTestId("rf__node-e2e-child")
      .locator(".flow-person-content")
      .click();
    await expect(
      page.getByText("Вторая локальная запись", { exact: true }),
    ).toBeVisible();
  } finally {
    const current = await (await request.get("/api/family")).json();
    const restored = await request.post("/api/family/changes", {
      headers: { "If-Match": String(current.revision) },
      data: {
        changes: original.map((p) => ({
          collection: "people",
          id: p.id,
          field: "biography",
          before: (current.family as Family).people.find(
            (item) => item.id === p.id,
          )?.biography,
          after: p.biography,
        })),
      },
    });
    expect(restored.status()).toBe(200);
  }
});
