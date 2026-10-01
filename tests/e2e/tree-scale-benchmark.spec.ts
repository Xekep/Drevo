import { expect, test } from "@playwright/test";
import { randomFamily } from "../layout-fixtures";

test("a large tree completes worker layout and remains interactive", async ({ page }, testInfo) => {
  test.skip(!process.env.DREVO_LAYOUT_SCALE_E2E || testInfo.project.name !== "desktop");
  test.setTimeout(240_000);
  const people = process.env.DREVO_LAYOUT_SCALE_PEOPLE === "500"
    ? randomFamily(1, 6) : randomFamily(5, 9);
  const withPortraits = !!process.env.DREVO_LAYOUT_SCALE_PORTRAITS;
  let releaseThumbs = () => {};
  const thumbGate = new Promise<void>((resolve) => { releaseThumbs = resolve; });
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
      ...(withPortraits ? { photo: `/media/e2e-scale-${person.id}.jpg` } : {}),
    }));
    data.family.links = [];
    data.family.photos = [];
    data.partial = false;
    data.user.personId = process.env.DREVO_LAYOUT_SCALE_KINSHIP ? people[0].id : null;
    await route.fulfill({ response, json: data });
  });
  if (withPortraits) await page.route("**/media/e2e-scale-*.jpg?variant=*", async (route) => {
    if (process.env.DREVO_LAYOUT_SCALE_SLOW_THUMB && route.request().url().includes("variant=thumb"))
      await thumbGate;
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#688a70"/></svg>',
    });
  });
  if (withPortraits && process.env.DREVO_LAYOUT_SCALE_KINSHIP) {
    await page.addInitScript((personId) => {
      const state: { first: { loaded: boolean; zoom: number } | null } = { first: null };
      Object.assign(window, { __introPortrait: state });
      const start = performance.now();
      const tick = () => {
        const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
        const image = document.querySelector<HTMLImageElement>(
          `[data-person-id="${personId}"] .person-avatar img`,
        );
        const zoom = viewport ? new DOMMatrix(getComputedStyle(viewport).transform).a : 0;
        if (zoom >= 0.18 && image) {
          state.first = { loaded: image.complete && image.naturalWidth > 0, zoom };
          return;
        }
        if (performance.now() - start < 40_000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, people[0].id);
  }
  await page.addInitScript((minimumPeople) => {
    const state = { requestedAt: 0, completedAt: 0, people: 0, occurrences: 0, branches: 0,
      positions: [] as [string, { x: number; y: number }][],
      occurrenceIds: [] as { id: string; personId: string }[],
      nodeSize: { width: 0, height: 0 } };
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
            state.positions = geometry.positions;
            state.occurrenceIds = geometry.occurrences;
            state.nodeSize = geometry.nodeSize;
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
    return { people: state.people, occurrences: state.occurrences, branches: state.branches,
      workerMs: Math.round(state.completedAt - state.requestedAt),
      mountedCards: document.querySelectorAll(".react-flow__node").length,
      mountedEdges: document.querySelectorAll(".react-flow__edge").length,
      distantCards: document.querySelectorAll(".flow-person.is-distant").length,
      distantImages: document.querySelectorAll(".flow-person.is-distant .person-avatar img").length,
      sceneNodes: Number(document.querySelector<HTMLCanvasElement>(".tree-distant-portraits")?.dataset.sceneNodes || 0),
      sceneEdges: Number(document.querySelector<HTMLCanvasElement>(".tree-distant-portraits")?.dataset.sceneEdges || 0),
      distantPortraits: Number(document.querySelector<HTMLCanvasElement>(".tree-distant-portraits")?.dataset.portraitCount || 0) };
  });
  expect(result.people).toBe(people.length);
  expect(result.occurrences).toBeGreaterThanOrEqual(people.length);
  if (people.length >= 600 && !process.env.DREVO_LAYOUT_SCALE_KINSHIP) {
    expect(result.sceneNodes).toBeGreaterThanOrEqual(people.length);
    expect(result.sceneEdges).toBeGreaterThan(0);
    expect(result.mountedCards).toBe(0);
    expect(result.mountedEdges).toBe(0);
  } else expect(result.mountedCards).toBeGreaterThan(0);
  if (withPortraits && process.env.DREVO_LAYOUT_SCALE_KINSHIP) {
    const first = await page.evaluate(() => (
      window as typeof window & { __introPortrait: {
        first: { loaded: boolean; zoom: number } | null;
      } }
    ).__introPortrait.first);
    expect(first?.loaded).toBe(true);
  }
  if (!process.env.DREVO_LAYOUT_SCALE_KINSHIP) {
    if (people.length < 600) expect(result.distantCards).toBeGreaterThan(0);
    expect(result.distantImages).toBe(0);
    if (withPortraits) expect(result.distantPortraits).toBeGreaterThan(0);
    else expect(result.distantPortraits).toBe(0);
  }
  console.log(`scale-browser ${JSON.stringify(result)}`);
  if (withPortraits && process.env.DREVO_LAYOUT_SCALE_ALIGNMENT && result.sceneNodes > 0) {
    await expect.poll(() => page.evaluate(() => Number(
      document.querySelector<HTMLCanvasElement>(".tree-distant-portraits")?.dataset.portraitCount || 0,
    ))).toBeGreaterThan(100);
    const initial = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(".tree-distant-portraits")!;
      const context = canvas.getContext("2d")!;
      const state = (window as typeof window & { __scaleLayout: {
        positions: [string, { x: number; y: number }][];
        nodeSize: { width: number; height: number };
      } }).__scaleLayout;
      const locate = (position: { x: number; y: number }) => {
        const viewport = document.querySelector<HTMLElement>(".react-flow__viewport")!;
        const matrix = new DOMMatrix(getComputedStyle(viewport).transform);
        const box = document.querySelector<HTMLElement>(".react-flow")!.getBoundingClientRect();
        return { x: box.left + matrix.e + (position.x + state.nodeSize.width / 2) * matrix.a,
          y: box.top + matrix.f + (position.y + 70) * matrix.a };
      };
      const matches = (position: { x: number; y: number }) => {
        const center = locate(position), box = canvas.getBoundingClientRect();
        const x = Math.round((center.x - box.x) * canvas.width / box.width);
        const y = Math.round((center.y - box.y) * canvas.height / box.height);
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
        const color = context.getImageData(x, y, 1, 1).data;
        return color[0] >= 115 && color[0] <= 145 &&
          Math.abs(color[0] - color[1]) <= 3 && Math.abs(color[1] - color[2]) <= 3;
      };
      const position = state.positions.map(([, value]) => value).find((value) => {
        const center = locate(value);
        return center.x > 100 && center.x < innerWidth - 200 &&
          center.y > 120 && center.y < innerHeight - 120 && matches(value);
      });
      if (!position) return false;
      const tracker = { active: true, samples: 0, matched: 0 };
      const sample = () => {
        if (!tracker.active) return;
        tracker.samples++;
        if (matches(position)) tracker.matched++;
        requestAnimationFrame(sample);
      };
      Object.assign(window, { __portraitAlignment: tracker, __portraitTick: sample });
      requestAnimationFrame(sample);
      return true;
    });
    expect(initial).toBe(true);
  }
  if (withPortraits && process.env.DREVO_LAYOUT_SCALE_ALIGNMENT && result.sceneNodes === 0) {
    await expect.poll(() => page.evaluate(() => Number(
      document.querySelector<HTMLCanvasElement>(".tree-distant-portraits")?.dataset.portraitCount || 0,
    ))).toBeGreaterThan(100);
    const initial = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(".tree-distant-portraits")!;
      const context = canvas.getContext("2d")!;
      const matches = (avatar: Element) => {
        const box = avatar.getBoundingClientRect();
        const canvasBox = canvas.getBoundingClientRect();
        const x = Math.round((box.x + box.width / 2 - canvasBox.x) * canvas.width / canvasBox.width);
        const y = Math.round((box.y + box.height / 2 - canvasBox.y) * canvas.height / canvasBox.height);
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
        const color = context.getImageData(x, y, 1, 1).data;
        return color[0] >= 115 && color[0] <= 145 &&
          Math.abs(color[0] - color[1]) <= 3 && Math.abs(color[1] - color[2]) <= 3;
      };
      const candidates = [...document.querySelectorAll(".flow-person.is-distant .person-avatar")];
      const avatar = candidates.find((item) => {
        const box = item.getBoundingClientRect();
        return box.x > 80 && box.right < innerWidth - 200 &&
          box.y > 80 && box.bottom < innerHeight - 120 && matches(item);
      });
      if (!avatar) return false;
      const state = { active: true, samples: 0, matched: 0 };
      const sample = () => {
        if (!state.active) return;
        state.samples++;
        if (matches(avatar)) state.matched++;
        requestAnimationFrame(sample);
      };
      Object.assign(window, { __portraitAlignment: state, __portraitTick: sample });
      requestAnimationFrame(sample);
      return true;
    });
    expect(initial).toBe(true);
  }
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
    await page.waitForTimeout(450);
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
    if (withPortraits && process.env.DREVO_LAYOUT_SCALE_ALIGNMENT) {
      const alignment = await page.evaluate(() => {
        const state = (window as typeof window & { __portraitAlignment: {
          active: boolean; samples: number; matched: number;
        } }).__portraitAlignment;
        state.active = false;
        return { samples: state.samples, matched: state.matched };
      });
      console.log(`scale-portrait-alignment ${JSON.stringify(alignment)}`);
      expect(alignment.samples).toBeGreaterThan(10);
      expect(alignment.matched / alignment.samples).toBeGreaterThan(0.8);
    }
  }
  if (withPortraits && process.env.DREVO_LAYOUT_SCALE_ALIGNMENT) {
    await page.evaluate(() => {
      const tracker = window as typeof window & { __portraitAlignment: {
        active: boolean; samples: number; matched: number;
      }; __portraitTick: () => void };
      Object.assign(tracker.__portraitAlignment, { active: true, samples: 0, matched: 0 });
      requestAnimationFrame(tracker.__portraitTick);
    });
    await page.locator(".flow-camera-tools button").nth(1).click();
    await page.waitForTimeout(200);
    const zoomAlignment = await page.evaluate(() => {
      const state = (window as typeof window & { __portraitAlignment: {
        active: boolean; samples: number; matched: number;
      } }).__portraitAlignment;
      state.active = false;
      return { samples: state.samples, matched: state.matched };
    });
    console.log(`scale-portrait-zoom-alignment ${JSON.stringify(zoomAlignment)}`);
    expect(zoomAlignment.samples).toBeGreaterThan(5);
    expect(zoomAlignment.matched / zoomAlignment.samples).toBeGreaterThan(0.8);
  }
  if (withPortraits && process.env.DREVO_LAYOUT_SCALE_SLOW_THUMB) {
    const zoomIn = page.locator(".flow-camera-tools button").nth(1);
    for (let index = 0; index < 16; index++) {
      const zoom = await page.locator(".react-flow__viewport").evaluate((element) =>
        new DOMMatrix(getComputedStyle(element).transform).a);
      if (zoom >= 0.18) break;
      await zoomIn.click();
    }
    const handoff = await page.evaluate(() => ({
      zoom: new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a,
      canvasVisible: getComputedStyle(document.querySelector(".tree-distant-portraits")!).visibility === "visible",
      pendingThumbs: [...document.querySelectorAll<HTMLImageElement>(".flow-person .person-avatar img")]
        .filter((image) => !image.complete).length,
    }));
    console.log(`scale-portrait-handoff ${JSON.stringify(handoff)}`);
    expect(handoff.zoom).toBeGreaterThanOrEqual(0.18);
    expect(handoff.pendingThumbs).toBeGreaterThan(0);
    expect(handoff.canvasVisible).toBe(true);
    releaseThumbs();
    await expect.poll(() => page.evaluate(() =>
      [...document.querySelectorAll<HTMLImageElement>(".flow-person .person-avatar img")]
        .filter((image) => !image.complete).length,
    ), { timeout: 20_000 }).toBe(0);
    await expect(page.locator(".tree-distant-portraits")).toHaveCSS("visibility", "hidden");
  }
  if (process.env.DREVO_LAYOUT_SCALE_SCREENSHOT) {
    await page.screenshot({ path: testInfo.outputPath("canvas-overview.png") });
    const zoomIn = page.locator(".flow-camera-tools button").nth(1);
    for (let index = 0; index < 6; index++) await zoomIn.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath("distant-portraits.png") });
    for (let index = 0; index < 2; index++) await zoomIn.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath("normal-portraits.png") });
  }
  if (process.env.DREVO_LAYOUT_SCALE_CLICK && result.sceneNodes > 0) {
    await page.locator(".flow-camera-tools button").nth(2).click();
    await expect.poll(() => page.evaluate(() =>
      new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a,
    )).toBeLessThan(0.18);
    await expect.poll(() => page.locator(".react-flow__node").count()).toBe(0);
    const target = await page.evaluate(() => {
      const state = (window as typeof window & { __scaleLayout: {
        positions: [string, { x: number; y: number }][];
        occurrenceIds: { id: string; personId: string }[];
        nodeSize: { width: number; height: number };
      } }).__scaleLayout;
      const peopleByOccurrence = new Map(state.occurrenceIds.map(({ id, personId }) => [id, personId]));
      const viewport = document.querySelector<HTMLElement>(".react-flow__viewport")!;
      const matrix = new DOMMatrix(getComputedStyle(viewport).transform);
      const box = document.querySelector<HTMLElement>(".react-flow")!.getBoundingClientRect();
      return state.positions.map(([id, position]) => ({
        id: peopleByOccurrence.get(id),
        x: box.left + matrix.e + (position.x + state.nodeSize.width / 2) * matrix.a,
        y: box.top + matrix.f + (position.y + state.nodeSize.height / 2) * matrix.a,
      })).find(({ id, x, y }) => id && x > box.left + 120 && x < box.right - 120 &&
        y > box.top + 120 && y < box.bottom - 120);
    });
    expect(target?.id).toBeTruthy();
    await page.mouse.click(target!.x, target!.y);
    await expect(page).toHaveURL(new RegExp(`/people/${target!.id}$`));
    await expect(page.locator(".inspector-dock")).toBeVisible();
  }
});
