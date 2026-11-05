import { expect, test as base } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server/index.ts";
import { e2eFamily } from "./base-family.ts";

// Other browser suites edit the shared fixture concurrently. This test checks
// database immutability, so both the page and the assertion need their own DB.
const test = base.extend<{ archiveUrl: string }>({
  archiveUrl: async ({ browserName }, provideArchive) => {
    const directory = await mkdtemp(join(tmpdir(), `drevo-layout-e2e-${browserName}-`));
    const app = await startServer(0, join(directory, "drevo.sqlite"), true);
    try {
      const current = await app.archive.read();
      await app.archive.write(e2eFamily(current.family), current.revision);
      const port = (app.server.address() as { port: number }).port;
      await provideArchive(`http://127.0.0.1:${port}`);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

for (const goal of ["routing", "compact"] as const) test(`AI ${goal} uses a real Worker without changing people or the camera`, async ({ page, request, archiveUrl }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const before = await (await request.get(`${archiveUrl}/api/family`)).json();
  await page.route("**/api/ai/status", route => route.fulfill({ json: { enabled: true, streaming: true } }));
  await page.route("**/api/ai/chats", route => route.fulfill({ json: { chats: [] } }));
  await page.route("**/api/ai/chat/stream", route => route.fulfill({
    contentType: "text/event-stream; charset=utf-8",
    body: `event: done\ndata: ${JSON.stringify({ answer: "Запускаю оптимизацию.", references: [], suggestionIds: [],
      uiActions: [{ type: "optimize_tree_layout", ...(goal === "compact" ? { goal } : {}) }], files: [] })}\n\n`,
  }));
  await page.addInitScript(() => {
    type G = { positions: [string, { x: number; y: number }][]; generationBands: { members: string[] }[] };
    const state: { goal?: string; before?: G; after?: G } = {};
    Object.assign(window, { __optimizedScene: state });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", e => { if (e.data.optimization) state.after = e.data.geometry; });
      }
      postMessage(message: unknown) {
        const body = message as { optimizeDisplayed?: boolean; layoutGoal?: string; previousGeometry?: G };
        if (body.optimizeDisplayed) { state.goal = body.layoutGoal; state.before = body.previousGeometry; }
        super.postMessage(message);
      }
    };
  });
  await page.goto(`${archiveUrl}/tree`);
  const canvas = page.locator(".tree-canvas");
  await expect(canvas, JSON.stringify(errors)).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-grow|is-layout-settling/);
  await expect(page.getByRole("button", { name: "Вписать видимую часть древа" })).toBeEnabled();
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  // Opening the assistant can resize the viewport; take the baseline afterwards.
  const viewport = canvas.locator(".react-flow__viewport");
  const transform = await viewport.getAttribute("style");
  const ids = await canvas.locator(".react-flow__node").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-id")).sort());
  const workerURLs: string[] = [];
  page.on("worker", worker => workerURLs.push(worker.url()));
  const assistant = page.locator(".research-assistant");
  await assistant.getByRole("textbox").fill(goal === "compact" ? "Размести карточки плотнее для печати" : "Оптимизируй расположение карточек для печати");
  await assistant.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.locator(".archive-toast")).toContainText(goal === "compact" ? /Древо уплотнено/ : /Расположение обновлено|Дополнительного улучшения/);
  expect(workerURLs.some(url => /layout\.worker/.test(url))).toBe(true);
  await expect(canvas).not.toHaveClass(/is-layout-settling/);
  expect(await canvas.locator(".react-flow__node").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-id")).sort())).toEqual(ids);
  expect(await viewport.getAttribute("style")).toEqual(transform);
  const packing = await page.evaluate(() => {
    type G = { positions: [string, { x: number; y: number }][]; generationBands: { members: string[] }[] };
    const state = (window as typeof window & { __optimizedScene: { goal?: string; before: G; after: G } }).__optimizedScene;
    const span = (g: G) => {
      const positions = new Map(g.positions);
      return g.generationBands.reduce((sum, band) => {
        const xs = band.members.map(id => positions.get(id)!.x);
        return sum + Math.max(...xs) - Math.min(...xs);
      }, 0);
    };
    return { goal: state.goal, before: span(state.before), after: span(state.after),
      oldY: state.before.positions.map(([id, p]) => [id, p.y]), newY: state.after.positions.map(([id, p]) => [id, p.y]) };
  });
  expect(packing.goal).toBe(goal);
  expect(packing.newY).toEqual(packing.oldY);
  if (goal === "compact") expect(packing.after).toBeLessThan(packing.before);
  if (goal === "compact") {
    await page.screenshot({ path: testInfo.outputPath("compact-tree.png") });
    await assistant.getByRole("button", { name: "Закрыть ИИ-исследователя" }).click();
    await expect(assistant).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("compact-tree-unobstructed.png") });
  }
  expect(await (await request.get(`${archiveUrl}/api/family`)).json()).toEqual(before);
  await expect(page.locator(".archive-toast")).toHaveCount(0, { timeout: 7000 });
  expect(errors).toEqual([]);
});


for (const combined of [false, true]) test(`AI recalculates only the filtered projection without reusing previous coordinates${combined ? " in the same reply" : ""}`, async ({ page, request, archiveUrl }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const before = await (await request.get(`${archiveUrl}/api/family`)).json();
  const ids = ["e2e-child", "e2e-spouse", "e2e-grandchild"];
  await page.route("**/api/ai/status", route => route.fulfill({ json: { enabled: true, streaming: true } }));
  await page.route("**/api/ai/chats", route => route.fulfill({ json: { chats: [] } }));
  let turn = 0;
  await page.route("**/api/ai/chat/stream", route => route.fulfill({
    contentType: "text/event-stream; charset=utf-8",
    body: `event: done\ndata: ${JSON.stringify({ answer: "Готово", references: [], suggestionIds: [], files: [],
      uiActions: ++turn === 1 ? [{ type: "filter_people", personIds: ids, label: "Тестовый фильтр" }, ...(combined ? [{ type: "recalculate_tree_layout" }] : [])] : [{ type: "recalculate_tree_layout" }] })}\n\n`,
  }));
  await page.addInitScript(() => {
    const requests: { people: { id: string }[]; previousGeometry?: unknown; previousInput?: unknown; optimizeDisplayed?: boolean }[] = [];
    Object.assign(window, { __freshLayoutRequests: requests });
    Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, { apply(target, receiver, args) {
      if (args[0]?.people) requests.push(args[0]);
      return Reflect.apply(target, receiver, args);
    } });
  });
  await page.goto(`${archiveUrl}/tree`);
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-grow/);
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const assistant = page.locator(".research-assistant");
  await assistant.getByRole("textbox").fill("Покажи выбранную семью");
  await assistant.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(canvas).toHaveAttribute("data-layout-people", String(ids.length));
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-layout-settling/);
  const count = () => page.evaluate(() => (window as typeof window & { __freshLayoutRequests: unknown[] }).__freshLayoutRequests.length);
  const previous = await count();
  if (!combined) {
    await assistant.getByRole("textbox").fill("Пересчитай расположение с учётом текущего фильтра");
    await assistant.getByRole("button", { name: "Отправить запрос" }).click();
  }
  await expect(page.locator(".archive-toast")).toContainText("Расположение пересчитано");
  if (!combined) expect(await count()).toBe(previous + 1);
  const input = await page.evaluate(() => (window as typeof window & { __freshLayoutRequests: {
    people: { id: string }[]; previousGeometry?: unknown; previousInput?: unknown; optimizeDisplayed?: boolean;
  }[] }).__freshLayoutRequests.at(-1)!);
  expect(input.people.map(person => person.id).sort()).toEqual([...ids].sort());
  expect(input.previousGeometry).toBeUndefined();
  expect(input.previousInput).toBeUndefined();
  expect(input.optimizeDisplayed).toBeUndefined();
  await expect(canvas).toHaveAttribute("data-layout-people", String(ids.length));
  expect(await (await request.get(`${archiveUrl}/api/family`)).json()).toEqual(before);
});
