import { test, expect, type Page } from "@playwright/test";
import type { UiAction } from "../../src/shared/research-protocol.ts";
import { familyViewAction } from "./tree-toolbar-actions";

async function fixture(page: Page, threshold: number) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/family?projection=overview", async route => {
    const response = await route.fetch(), data = await response.json();
    const template = data.family.people[0];
    data.family.people = Array.from({ length: 100 }, (_, index) => ({ ...template,
      id: `scope-${index}`, name: `Человек ${index}`, surname: "Проверка", patronymic: "",
      birth: "1900", photo: undefined, parents: index > 0 && index < 7 ? [`scope-${index - 1}`] : [],
      spouses: [], generation: index + 1, needsReview: index === 5,
    }));
    data.family.links = []; data.family.unions = []; data.family.photos = [];
    data.partial = false; data.totals.people = 100; data.user.personId = "scope-0";
    data.treePreferences = { ...data.treePreferences, fragmentThreshold: threshold, animateOnLoad: false };
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/ai/status", route => route.fulfill({ json: { enabled: true, streaming: true } }));
  await page.route("**/api/ai/chats", route => route.fulfill({ json: { chats: [] } }));
  const contexts: Array<{ treeView: { personIds: string[]; fragment: boolean; filtered: boolean } }> = [];
  let action: UiAction;
  let sequence = 0;
  await page.route("**/api/ai/chat/stream", route => {
    contexts.push(route.request().postDataJSON().context);
    return route.fulfill({ contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({ answer: `Команда ${sequence} передана.`, references: [], suggestionIds: [], uiActions: [action], files: [] })}\n\n` });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(page.getByRole("button", { name: "Вписать видимую часть древа" })).toBeEnabled();
  return { canvas, contexts,
    async command(next: UiAction) {
      action = next;
      sequence++;
      await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
      const assistant = page.locator(".research-assistant");
      await assistant.getByRole("textbox").fill("Скрой выбранных людей");
      await assistant.getByRole("button", { name: "Отправить запрос" }).click();
      await expect(assistant.getByText(`Команда ${sequence} передана.`, { exact: true })).toBeVisible();
      await expect(assistant.getByRole("button", { name: "Остановить ответ" })).toHaveCount(0);
      await expect(page.locator(".tree-filter-status")).toBeVisible();
      await assistant.getByRole("button", { name: "Закрыть ИИ-исследователя" }).click();
      await expect(canvas).toHaveAttribute("data-layout-ready", "true");
      const count = await canvas.getAttribute("data-layout-people");
      const summary = page.getByRole("group", { name: "Сводка выборки древа" });
      await expect(summary).toBeVisible();
      await expect(summary).toContainText(`Выборка: ${count} из 100`);
      await expect(page.locator(".tree-filter-status, .tree-generation-status, .tree-fragment-status").filter({ hasText: /\d+ из \d+/ })).toHaveCount(0);
    },
  };
}

test("AI subtraction and review flags preserve the current explicit selection and reset explicitly", async ({ page, request }) => {
  const before = await (await request.get("/api/family")).json();
  const { canvas, command, contexts } = await fixture(page, 0);
  await command({ type: "filter_people", personIds: ["scope-0", "scope-1", "scope-2", "scope-5", "scope-6"], label: "Текущая выборка" });
  await expect(canvas).toHaveAttribute("data-layout-people", "5");
  await expect(canvas).not.toHaveClass(/is-layout-settling/);
  const camera = await page.locator(".react-flow__viewport").getAttribute("style");
  await command({ type: "exclude_people", personIds: ["scope-1"], label: "Без первого" });
  await expect(canvas).toHaveAttribute("data-layout-people", "4");
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).toBe(camera);
  expect(contexts.at(-1)!.treeView.personIds.sort()).toEqual(["scope-0", "scope-1", "scope-2", "scope-5", "scope-6"]);
  await command({ type: "hide_review_people" });
  await expect(canvas).toHaveAttribute("data-layout-people", "3");
  await command({ type: "exclude_people", personIds: ["scope-6"], label: "Без шестого" });
  await expect(canvas).toHaveAttribute("data-layout-people", "2");
  expect(contexts.at(-1)!.treeView.personIds.sort()).toEqual(["scope-0", "scope-2", "scope-6"]);
  await page.getByRole("button", { name: "Всё древо", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-layout-people", "100");
  expect(await (await request.get("/api/family")).json()).toEqual(before);
});

test("AI exclusions keep close-family expansion and the active fragment instead of reopening the tree", async ({ page }, info) => {
  const { canvas, command, contexts } = await fixture(page, 100);
  await expect(canvas).toHaveAttribute("data-layout-people", "4");
  const card = (index: number) => page.locator(`.flow-person[data-person-id="scope-${index}"]`);
  await card(0).locator(".flow-person-content").click();
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Свернуть панель" }).click();
  await familyViewAction(page, "Близкие");
  await page.getByRole("button", { name: /Закрыть панель/ }).click();
  await expect(canvas).toHaveAttribute("data-layout-people", "2");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await card(1).getByRole("button", { name: /^Показать ещё 1 родственников:/ }).click();
  await expect(canvas).toHaveAttribute("data-layout-people", "3");
  await command({ type: "exclude_people", personIds: ["scope-2"], label: "Без второго" });
  await expect(canvas).toHaveAttribute("data-layout-people", "2");
  expect(contexts.at(-1)!.treeView).toMatchObject({ fragment: false, filtered: true });
  await expect(card(1).getByRole("button", { name: /^Свернуть раскрытую ветвь:/ })).toBeAttached();
  // Resetting the AI projection is explicit; the separate fragment choice survives.
  await page.getByRole("button", { name: "Всё древо", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-layout-people", "4");
  await command({ type: "exclude_people", personIds: ["scope-0"], label: "Без опорного" });
  await expect(canvas).toHaveAttribute("data-layout-people", "3");
  await expect(page.getByRole("region", { name: "Фрагмент большого древа" })).toBeVisible();
  expect(contexts.at(-1)!.treeView).toMatchObject({ fragment: true });
  await expect(canvas).toHaveAttribute("data-fragment-anchor", "scope-0");
  await expect(card(3).getByRole("button", { name: /^Ещё 1 родственник:/ })).toBeAttached();
});
