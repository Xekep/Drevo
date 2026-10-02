import { expect, test } from "@playwright/test";
import { sharedFamily } from "../../src/domain/shared-family.ts";
import type { Family } from "../../src/domain/types.ts";

test("shared person card shows cited current and competing birth dates", async ({ page, request }) => {
  const snapshot = await (await request.get("/api/family")).json();
  const family = snapshot.family as Family;
  const person = family.people.find((item) => item.id === "e2e-child")!;
  const alternative = person.birth === "1901" ? "1902" : "1901";
  person.birthDateClaim = { value: person.birth, confidence: "probable",
    sources: [{ title: "Текущая запись", type: "архив", reference: "л. 1" }] };
  person.factAlternatives = [{ id: "other-birth", field: "birth", value: alternative,
    confidence: "conflicting",
    sources: [{ title: "Другая запись", type: "архив", reference: "л. 2" }] }];
  const token = "v".repeat(43);
  const projection = sharedFamily(family, { id: "share", title: "Фрагмент",
    anchorId: person.id, personIds: [person.id], createdAt: "2026-01-01",
    expiresAt: "2027-01-01", createdBy: "owner", createdName: "Владелец",
    revokedAt: null, lastVisitedAt: null }, token);
  await page.route(`**/api/shared/${token}`, (route) => route.fulfill({ json: {
    family: projection, serverTime: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  } }));
  await page.goto(`/s/${token}`);
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  const inspector = page.locator(".inspector-dock");
  await expect(inspector).toContainText("Источники даты: Текущая запись");
  await expect(inspector).toContainText("Другая дата рождения");
  await expect(inspector).toContainText("Другая запись");
});
