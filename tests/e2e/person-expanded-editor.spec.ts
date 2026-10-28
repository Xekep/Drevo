import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import { fullName } from "../../src/domain/dates.ts";
import type { Family } from "../../src/domain/types.ts";
import { savePersonDetails } from "./person-editor-actions";

async function openEditor(page: Page, withBirthEvidence = false) {
  const response = await page.request.get("/api/family?projection=overview");
  const header = await response.json();
  let family = structuredClone((await (await page.request.get("/api/family")).json()).family) as Family;
  const original = family.people.find(person => person.id === "e2e-child")!;
  original.biography = "Исходная история";
  if (withBirthEvidence) {
    original.maidenName = "Иванов";
    original.maidenNameClaim = { value: "Иванов", sources: [{ title: "Метрическая книга", type: "", reference: "л. 7" }] };
  }
  let revision = header.revision;
  await page.route("**/api/family?projection=overview", route => route.fulfill({
    response, json: { ...header, family, revision, partial: false },
  }));
  await page.route("**/api/family/changes", route => {
    const changes = route.request().postDataJSON().changes as Change[];
    const result = applyArchiveChanges(family, changes);
    expect(result.conflicts).toEqual([]);
    family = result.family;
    return route.fulfill({ json: { family, revision: ++revision, appliedChanges: changes } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await expect(page.locator('.person-editor-form [data-field="name"]')).toBeVisible();
  return () => family.people.find(person => person.id === "e2e-child")!;
}

test("expanded life section drafts occupation and history together and applies through person save", async ({ page, isMobile }, info) => {
  const read = await openEditor(page);
  const form = page.locator(".person-editor-form");
  const section = form.locator(".person-life-editor");
  await expect(section).not.toHaveAttribute("open");
  const inline = section.locator(":scope > label > textarea");
  await expect(inline).toHaveValue("Исходная история");
  const initialOccupation = read().occupation || "";
  const open = form.getByRole("button", { name: "Открыть жизнь и занятия в отдельном окне" });
  const lifeHeader = section.locator(":scope > summary");
  const neighboringHeader = form.locator(".education-editor > summary");
  const appearance = (element: Element) => {
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, size: style.fontSize,
      weight: style.fontWeight, line: style.lineHeight };
  };
  const lifeStyle = await lifeHeader.evaluate(appearance), neighborStyle = await neighboringHeader.evaluate(appearance);
  expect(lifeStyle.height).toBeCloseTo(neighborStyle.height, 1);
  expect({ ...lifeStyle, height: 0 }).toEqual({ ...neighborStyle, height: 0 });
  await open.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("person-editor-sections.png") });
  const buttonBox = (await open.boundingBox())!;
  expect(buttonBox.width).toBe(24);
  expect(buttonBox.height).toBe(24);
  await expect(open.locator("svg")).toHaveAttribute("width", "14");
  if (isMobile) {
    // A 44px transparent touch target does not increase the summary's row height.
    const touchTarget = await open.evaluate(button => {
      const style = getComputedStyle(button, "::before");
      return { width: parseFloat(style.width), height: parseFloat(style.height) };
    });
    expect(touchTarget.width).toBeGreaterThanOrEqual(44);
    expect(touchTarget.height).toBeGreaterThanOrEqual(44);
    await page.touchscreen.tap(buttonBox.x - 8, buttonBox.y + buttonBox.height / 2);
  } else await open.click();
  const dialog = page.getByRole("dialog", { name: "Жизнь и занятия", exact: true });
  const expanded = dialog.getByRole("textbox", { name: "История человека", exact: true });
  await expect(expanded).toHaveValue("Исходная история");
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box.width).toBeGreaterThan(isMobile ? 300 : 600);
  await dialog.getByLabel("Занятие", { exact: true }).fill("Несохранённое занятие");
  expect(read().biography).toBe("Исходная история");
  expect(read().occupation || "").toBe(initialOccupation);
  page.once("dialog", confirmation => confirmation.dismiss());
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(dialog).toBeVisible();
  page.once("dialog", confirmation => confirmation.accept());
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(inline).toHaveValue("Исходная история");
  await expect(section).not.toHaveAttribute("open");
  await expect(form.getByLabel("Занятие", { exact: true })).toHaveValue(initialOccupation);
  await expect(open).toBeFocused();
  await open.click();
  const value = "## История\n\nПервая строка.\nВторая строка с **важной** деталью.";
  await dialog.getByLabel("Занятие", { exact: true }).fill("Учитель");
  await expanded.fill(value);
  await page.screenshot({ path: info.outputPath("expanded-life-editor.png") });
  await dialog.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(inline).toHaveValue(value);
  await expect(form.getByLabel("Занятие", { exact: true })).toHaveValue("Учитель");
  expect(read().biography).toBe("Исходная история");
  expect(read().occupation || "").toBe(initialOccupation);
  await savePersonDetails(page);
  expect(read().biography).toBe(value);
  expect(read().occupation).toBe("Учитель");
});

test("birth surname is independent from the sole current full-name input", async ({ page }) => {
  const read = await openEditor(page);
  const form = page.locator(".person-editor-form");
  const original = structuredClone(read());
  await expect(form.getByText("ФИО и фамилия при рождении", { exact: true })).toHaveCount(0);
  await expect(form.getByRole("textbox", { name: "Имя", exact: true })).toHaveCount(0);
  await form.getByLabel("Фамилия при рождении", { exact: true }).fill("ДругаяФамилия");
  await expect(form.locator('[data-field="name"]')).toHaveValue(fullName(original));
  await savePersonDetails(page);
  expect(read()).toMatchObject({ surname: original.surname, name: original.name,
    patronymic: original.patronymic, maidenName: "ДругаяФамилия" });
});

test("legacy birth-surname evidence remains available without editing current names", async ({ page }) => {
  const read = await openEditor(page, true);
  const form = page.locator(".person-editor-form");
  const original = structuredClone(read());
  await form.getByText("Записи о фамилии при рождении", { exact: true }).click();
  await form.locator(".birth-surname-claim > summary").click();
  await expect(form.getByLabel("Название", { exact: true })).toHaveValue("Метрическая книга");
  await savePersonDetails(page);
  expect(read().maidenNameClaim).toEqual(original.maidenNameClaim);
  expect(fullName(read())).toBe(fullName(original));
});
