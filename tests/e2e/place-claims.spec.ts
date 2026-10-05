import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

for (const { kind, personId, label, place } of [
  { kind: "birth", personId: "e2e-child", label: "рождения", place: "Москва" },
  { kind: "death", personId: "e2e-memorial-person", label: "смерти", place: "Тула" },
] as const) {
  test(`каталожный источник места ${label} не переносится на другое место`, async ({ page }, info) => {
    const title = `Запись о месте ${label} ${info.project.name}`;
    const source = { id: `${kind}-place-${info.project.name}`, title, version: 1,
      type: "архив", author: "", institution: "", archive: "ГАСО", fond: "6",
      opis: "", delo: "", sheet: "", reference: "", url: "", accessedAt: "",
      description: "", documentIds: [] };
    await page.route("**/api/sources?*", async (route) =>
      route.fulfill({ json: { sources: [source], total: 1 } }));
    await page.route("**/api/places/locate?*", async (route) =>
      route.fulfill({ json: { automatic: null, candidates: [] } }));
    const response = await page.request.get("/api/family?projection=overview");
    const initial = await response.json();
    let family = structuredClone(initial.family) as Family;
    let revision = initial.revision as number;
    await page.route("**/api/family?projection=overview", async (route) =>
      route.fulfill({ response, json: { ...initial, family, revision } }));
    await page.route("**/api/family/changes", async (route) => {
      const changes = route.request().postDataJSON().changes as Change[];
      family = applyArchiveChanges(family, changes).family;
      revision++;
      await route.fulfill({ json: { family, revision, appliedChanges: changes } });
    });
    await page.goto("/tree");
    await page.getByTestId(`rf__node-${personId}`).locator(".flow-person-content").click();
    await page.locator(".inspector-person-actions .person-edit-button").click();
    const group = page.locator(".person-date-group")
      .filter({ has: page.getByRole("heading", { name: kind === "birth" ? "Рождение" : "Смерть" }) });
    const placeInput = group.locator('input[placeholder="Название в то время"]');
    await placeInput.fill(place);
    await placeInput.blur();
    await expect(group.getByRole("status")).toBeVisible();
    const claim = group.locator(`.${kind}-place-claim`);
    await group.locator(".person-evidence-details > summary").click();
    await claim.locator("summary").click();
    await expect(claim).toHaveAttribute("open", "");
    await claim.getByRole("button", { name: "Выбрать из каталога" }).click();
    await claim.getByLabel("Поиск источника").fill(title);
    await claim.locator(".union-catalog-results").getByRole("button", { name: title }).click();
    await expect(claim.getByRole("combobox", { name: /Достоверность/ })).toHaveValue("");
    const confidence = kind === "birth" ? "tentative" : "conflicting";
    await claim.getByRole("combobox", { name: /Достоверность/ }).selectOption(confidence);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    const claimKey = kind === "birth" ? "birthPlaceClaim" : "deathPlaceClaim";
    await expect.poll(() => family.people.find((person) => person.id === personId)?.[claimKey]?.sources[0].catalogId)
      .toBe(source.id);
    expect(family.people.find((person) => person.id === personId)?.[claimKey]?.value).toBe(place);
    expect(family.people.find((person) => person.id === personId)?.[claimKey]?.confidence).toBe(confidence);
    await expect(page.getByText(`Источники места: ${title} · Оценка: ${kind === "birth" ? "Предположительно" : "Противоречиво"}`)).toBeVisible();

    await page.locator(".inspector-person-actions .person-edit-button").click();
    const changedGroup = page.locator(".person-date-group")
      .filter({ has: page.getByRole("heading", { name: kind === "birth" ? "Рождение" : "Смерть" }) });
    await changedGroup.locator(".person-evidence-details > summary").click();
    await changedGroup.locator(`.${kind}-place-claim > summary`).click();
    await changedGroup.locator('input[placeholder="Название в то время"]').fill("Другое место");
    await expect(page.getByRole("alert").filter({ hasText: "Источники относятся к прежнему месту" })).toBeVisible();
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByText(new RegExp(`Источник места ${label} относится к другому значению`))).toBeVisible();
    await page.getByRole("button", { name: "Снять связи с прежним местом" }).click();
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    const placeKey = kind === "birth" ? "birthPlace" : "deathPlace";
    await expect.poll(() => family.people.find((person) => person.id === personId)?.[placeKey])
      .toBe("Другое место");
    expect(family.people.find((person) => person.id === personId)?.[claimKey]).toBeUndefined();
  });
}
