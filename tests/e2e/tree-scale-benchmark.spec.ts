import { expect, test } from "@playwright/test";
import { randomFamily } from "../layout-fixtures";

test("a large tree completes worker layout and remains interactive", async ({ page }, testInfo) => {
  test.skip(!process.env.DREVO_LAYOUT_SCALE_E2E || testInfo.project.name !== "desktop");
  test.setTimeout(240_000);
  const people = process.env.DREVO_LAYOUT_SCALE_PEOPLE === "500"
    ? randomFamily(1, 6) : randomFamily(5, 9);
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.family.people = people.map((person) => ({
      ...person,
      name: person.id,
      surname: "Тестов",
      patronymic: "",
      sex: "m",
      birthPlace: "",
      sources: [],
      generation: 1,
      column: 0,
    }));
    data.family.links = [];
    data.family.photos = [];
    data.partial = false;
    data.user.personId = process.env.DREVO_LAYOUT_SCALE_KINSHIP ? people[0].id : null;
    await route.fulfill({ response, json: data });
  });
  await page.addInitScript((minimumPeople) => {
    const state = { requestedAt: 0, completedAt: 0, people: 0, occurrences: 0, branches: 0 };
    Object.assign(window, { __scaleLayout: state });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event: MessageEvent) => {
          const geometry = event.data?.geometry;
          if (geometry?.occurrences?.length >= minimumPeople) {
            state.completedAt = performance.now();
            state.occurrences = geometry.occurrences.length;
            state.branches = geometry.branches?.length || 0;
          }
        });
      }
      postMessage(message: unknown, transfer: Transferable[] | StructuredSerializeOptions = []) {
        if (message && typeof message === "object" && "people" in message &&
            Array.isArray(message.people) && message.people.length >= minimumPeople) {
          state.requestedAt = performance.now();
          state.people = message.people.length;
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
  }, people.length);
  await page.goto("/tree");
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __scaleLayout: { occurrences: number } }).__scaleLayout.occurrences,
  ), { timeout: 210_000 }).toBeGreaterThanOrEqual(people.length);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/, { timeout: 30_000 });
  const result = await page.evaluate(() => {
    const state = (window as typeof window & { __scaleLayout: {
      requestedAt: number; completedAt: number; people: number;
      occurrences: number; branches: number;
    } }).__scaleLayout;
    return { ...state, workerMs: Math.round(state.completedAt - state.requestedAt),
      mountedCards: document.querySelectorAll(".react-flow__node").length,
      mountedEdges: document.querySelectorAll(".react-flow__edge").length,
      distantCards: document.querySelectorAll(".flow-person.is-distant").length,
      distantImages: document.querySelectorAll(".flow-person.is-distant .person-avatar img").length };
  });
  expect(result.people).toBe(people.length);
  expect(result.occurrences).toBeGreaterThanOrEqual(people.length);
  expect(result.mountedCards).toBeGreaterThan(0);
  if (!process.env.DREVO_LAYOUT_SCALE_KINSHIP) {
    expect(result.distantCards).toBeGreaterThan(0);
    expect(result.distantImages).toBe(0);
  }
  console.log(`scale-browser ${JSON.stringify(result)}`);
  const pane = page.locator(".react-flow__pane");
  await expect(pane).toBeVisible();
  const box = await pane.boundingBox();
  if (box) {
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.evaluate(() => {
      const state = { active: true, last: 0, gaps: [] as number[] };
      Object.assign(window, { __scaleFrames: state });
      const sample = (now: number) => {
        if (!state.active) return;
        if (state.last) state.gaps.push(now - state.last);
        state.last = now;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 180, y + 80, { steps: 80 });
    await page.mouse.up();
    await expect(pane).toBeVisible();
    const frames = await page.evaluate(() => {
      const state = (window as typeof window & { __scaleFrames: {
        active: boolean; gaps: number[];
      } }).__scaleFrames;
      state.active = false;
      const sorted = [...state.gaps].sort((a, b) => a - b);
      return { count: sorted.length, p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0),
        maxMs: Math.round(sorted.at(-1) || 0), over50Ms: sorted.filter((gap) => gap > 50).length };
    });
    console.log(`scale-pan ${JSON.stringify(frames)}`);
    expect(frames.count).toBeGreaterThan(0);
  }
});
