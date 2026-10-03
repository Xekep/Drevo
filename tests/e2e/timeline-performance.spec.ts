import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { horizontalTimeline, timelineRowsAtYear } from "../../src/domain/horizontal-timeline";
import type { Family } from "../../src/domain/types";
import type { Change } from "../../src/domain/changes";
import { installTreeAcceptanceProbe, readTreeAcceptanceProbe } from "./tree-acceptance-probe";

// Hardware diagnostic only: normal CI neither seeds a large archive nor times it.
test.use({ trace: "off", actionTimeout: 30_000 });
test("production timeline entry, year scroll, people scroll and deep search", async ({ page }, testInfo) => {
  test.skip(process.env.DREVO_TIMELINE_PERFORMANCE !== "1" || process.env.DREVO_TREE_ACCEPTANCE !== "1");
  test.skip(testInfo.project.name !== "desktop", "Hardware desktop benchmark; mobile needs a separate protocol");
  test.setTimeout(600_000);
  const count = Number(process.env.DREVO_TREE_ACCEPTANCE_PEOPLE || 977);
  expect([977, 3313]).toContain(count);
  const throttle = Number(process.env.DREVO_TREE_ACCEPTANCE_CPU || 4);
  const horizontalPerDirection = count === 3313 ? 8 : 20;
  expect(Number.isFinite(throttle) && throttle >= 1).toBe(true);
  const tag = process.env.DREVO_TIMELINE_TAG || "baseline";
  expect(tag).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  const directory = "F:/Codex/drevo-timeline-tests";
  await mkdir(directory, { recursive: true });
  const name = `timeline-${count}-desktop-cpu${throttle}-${tag}`;
  const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const sourceFiles = [
    "src/components/tree/horizontal-timeline.tsx", "src/domain/horizontal-timeline.ts",
    "src/styles/timeline.css", "src/components/tree/tree-canvas.tsx",
    "src/components/tree/tree-render-family.ts", "src/components/tree/use-family-view.ts",
    "src/components/person-panel.tsx", "src/components/tree-search.tsx",
    "src/hooks/useArchive.ts", "src/hooks/useWorkspaceSelection.ts", "src/domain/dates.ts",
    "src/domain/person-events.ts", "src/domain/archive-projection.ts", "src/App.tsx",
    "tests/e2e/tree-acceptance-fixture.ts", "tests/e2e/timeline-performance.spec.ts", "package-lock.json",
    ...readdirSync("src/domain").filter((file) => file === "timeline-window.ts").map((file) => `src/domain/${file}`),
  ];
  const buildFiles = (path: string): string[] => readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? buildFiles(join(path, entry.name)) : [join(path, entry.name)])
    .filter((file) => /\.(js|css|html)$/.test(file)).sort();
  const provenance = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceHashes: Object.fromEntries(sourceFiles.map((file) => [file, hash(readFileSync(file))])),
    buildHashes: Object.fromEntries(buildFiles("dist").map((file) => [file.replaceAll("\\", "/"), hash(readFileSync(file))])),
  };

  // The acceptance seed intentionally has unknown birth dates. Add reproducible
  // synthetic dates through the real write API before measuring any navigation.
  await expect.poll(async () => (await (await page.request.get("/api/family?projection=overview")).json()).totals?.people,
    { timeout: 180_000, intervals: [500, 1000] }).toBe(count);
  let current: { family: Family; revision: number } = await (await page.request.get("/api/family")).json();
  const depths = new Map<string, number>();
  const changes: Change[] = current.family.people.map((person, index) => {
    const depth = person.parents.length ? 1 + Math.max(...person.parents.map((id) => {
      const value = depths.get(id);
      if (value === undefined) throw new Error("Synthetic fixture parents must precede their descendants");
      return value;
    })) : 0;
    depths.set(person.id, depth);
    return { collection: "people", id: person.id, field: "birth", before: person.birth,
      after: `${1750 + depth * 20 + index % 7}-01-01` };
  });
  const origin = new URL(testInfo.project.use.baseURL!).origin;
  for (let offset = 0; offset < changes.length; offset += 250) {
    const response = await page.request.post("/api/family/changes", {
      headers: { "If-Match": String(current.revision), Origin: origin, Prefer: "return=minimal" },
      data: { changes: changes.slice(offset, offset + 250) },
    });
    expect(response.status()).toBe(200);
    current = await response.json();
  }
  const family: Family = (await (await page.request.get("/api/family")).json()).family;
  expect(family.people).toHaveLength(count);
  const model = horizontalTimeline(family.people);
  expect(timelineRowsAtYear(model.rows, 2020)).toHaveLength(count);
  const target = model.rows.at(-1)!.person;
  const targetRank = timelineRowsAtYear(model.rows, Number(target.birth.slice(0, 4)))
    .findIndex((row) => row.person.id === target.id);
  expect(targetRank).toBeGreaterThan(count * 0.9);
  const profile = process.env.DREVO_TIMELINE_PROFILE === "1";
  await installTreeAcceptanceProbe(page);
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const browserSession = await page.context().browser()!.newBrowserCDPSession();
  const { gpu } = await browserSession.send("SystemInfo.getInfo");
  await browserSession.detach();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const pendingMedia = new Set<import("@playwright/test").Request>();
  let mediaRequests = 0, mediaFailures = 0, peakPendingMedia = 0;
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.startsWith("/media/")) return;
    pendingMedia.add(request);
    mediaRequests++;
    peakPendingMedia = Math.max(peakPendingMedia, pendingMedia.size);
  });
  const finish = (request: import("@playwright/test").Request) => { pendingMedia.delete(request); };
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/media/") && response.status() >= 400) mediaFailures++;
  });
  const counters = async () => Object.fromEntries((await session.send("Performance.getMetrics")).metrics
    .map(({ name, value }) => [name, value]));
  const phases: unknown[] = [];
  const marker = page.getByLabel("Год в центре хронологии");
  const timeline = page.getByRole("region", { name: /Горизонтальная хронология/ });
  const mediaIdle = async () => {
    await expect.poll(() => pendingMedia.size, { timeout: 60_000 }).toBe(0);
    await page.waitForTimeout(350);
    await expect.poll(() => pendingMedia.size, { timeout: 60_000 }).toBe(0);
  };
  const frameBoundary = async () => page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const snapshot = async (phase: string, before?: Record<string, number>, startedAt?: number) => {
    // Stop timing before DOM rectangles are sampled: their forced layout belongs
    // to the observer, not the application's gesture or rendering workload.
    const endedAt = await page.evaluate(() => performance.now());
    const after = await counters();
    const probe = await readTreeAcceptanceProbe(page);
    const dom = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".horizontal-timeline");
      if (!viewport) return null;
      const bounds = viewport.getBoundingClientRect();
      const rows = [...viewport.querySelectorAll<HTMLElement>(".timeline-person-row")];
      const activeRows = rows.filter((row) => !row.classList.contains("is-exiting"));
      const onScreen = activeRows.filter((row) => {
        const rectangle = row.getBoundingClientRect();
        return rectangle.bottom > bounds.top + 86 && rectangle.top < bounds.bottom && rectangle.height > 0;
      });
      const portraits = onScreen.flatMap((row) => [...row.querySelectorAll<HTMLImageElement>(".person-avatar img")]);
      const year = Number(document.querySelector(".timeline-center-marker output")?.textContent);
      return { year, domNodes: document.querySelectorAll("*").length,
        timelineDomNodes: viewport.querySelectorAll("*").length,
        mountedRows: rows.length, mountedActiveRows: activeRows.length, exitingRows: rows.length - activeRows.length,
        screenRows: onScreen.length, screenPersonIds: onScreen.map((row) => row.dataset.personId),
        mountedEvents: viewport.querySelectorAll(".timeline-event").length,
        visiblePortraits: portraits.length, loadedVisiblePortraits: portraits.filter((image) => image.complete && image.naturalWidth > 0).length,
        summary: document.querySelector(".timeline-center-marker > span")?.textContent,
        scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight, scrollWidth: viewport.scrollWidth,
        viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
      };
    });
    const durations = Object.fromEntries(["ScriptDuration", "TaskDuration", "LayoutDuration", "RecalcStyleDuration"]
      .map((key) => [key + "Ms", (after[key] - (before?.[key] ?? after[key])) * 1000]));
    const result = { phase, measuredMs: startedAt === undefined ? null : endedAt - startedAt,
      ...durations, layoutCount: after.LayoutCount - (before?.LayoutCount ?? after.LayoutCount),
      styleCount: after.RecalcStyleCount - (before?.RecalcStyleCount ?? after.RecalcStyleCount),
      mainThreadHeapBytes: after.JSHeapUsedSize,
      frames: probe.frames, longTasks: probe.longTasks, workerRequests: probe.requests.length,
      mediaRequests, pendingMedia: pendingMedia.size, peakPendingMedia, mediaFailures,
      ...dom, eligiblePeopleAtYear: dom ? timelineRowsAtYear(model.rows, dom.year).length : null };
    phases.push(result);
    console.log("timeline-performance " + JSON.stringify(result));
    return result;
  };
  const measure = async (phase: string, action: () => Promise<void>) => {
    await readTreeAcceptanceProbe(page, true);
    const before = await counters();
    const startedAt = await page.evaluate(() => performance.now());
    if (profile && phase === "horizontal-years") {
      await session.send("Profiler.enable");
      await session.send("Profiler.start");
    }
    await action();
    await frameBoundary();
    const result = await snapshot(phase, before, startedAt);
    if (profile && phase === "horizontal-years") {
      const { profile: cpuProfile } = await session.send("Profiler.stop");
      await writeFile(join(directory, name + ".cpuprofile"), JSON.stringify(cpuProfile));
      await session.send("Profiler.disable");
    }
    return result;
  };

  await page.goto("/tree");
  const root = page.locator(".tree-canvas");
  await expect(root).toHaveAttribute("data-layout-ready", "true", { timeout: 180_000 });
  await expect(root).toHaveAttribute("data-layout-people", String(count));
  await expect(root).not.toHaveClass(/is-grow|is-layout-settling/, { timeout: 60_000 });
  await expect(page.locator(".archive-loading-details")).toHaveCount(0, { timeout: 60_000 });
  await mediaIdle();
  await snapshot("tree-ready");
  await measure("enter-sparse-timeline", async () => {
    await page.getByRole("button", { name: "Хронология", exact: true }).click();
    await expect(timeline).toBeVisible();
    await expect(marker).toHaveText("1750");
    await expect(timeline.locator(".timeline-person-row").first()).toBeAttached();
  });
  await mediaIdle();
  await snapshot("sparse-year-settled");
  await measure("jump-year-2020", async () => {
    await timeline.evaluate((element, left) => element.scrollTo({ left, top: 0, behavior: "instant" }), model.yearX(2020));
    await expect(marker).toHaveText("2020");
    await expect(page.locator(".timeline-center-marker > span")).toContainText(String(count));
  });
  await mediaIdle();
  await snapshot("full-year-2020-settled");
  const bounds = (await timeline.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + 120);
  await measure("horizontal-years", async () => {
    for (const direction of [-1, 1])
      for (let index = 0; index < horizontalPerDirection; index++) {
        await page.mouse.wheel(0, direction * 120);
        await page.waitForTimeout(32);
      }
    await expect(marker).toHaveText("2020");
  });
  await mediaIdle();
  await snapshot("year-scroll-settled");
  const initialTop = await timeline.evaluate((element) => element.scrollTop);
  await measure("vertical-people", async () => {
    await page.keyboard.down("Shift");
    try {
      for (let index = 0; index < 16; index++) {
        await page.mouse.wheel(0, bounds.height * 0.8);
        await page.waitForTimeout(32);
      }
    } finally {
      await page.keyboard.up("Shift");
    }
    await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialTop + bounds.height);
    await expect(marker).toHaveText("2020");
  });
  await mediaIdle();
  await snapshot("people-scroll-settled");
  // Place the viewport at the start before selecting a person whose model rank
  // is near the end. The endpoint checks the actual card, never a DOM-count rule.
  await timeline.evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
  await frameBoundary();
  await measure("search-deep-person", async () => {
    await page.getByRole("combobox", { name: /Найти человека/ }).fill(target.name);
    const escapedName = target.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await page.getByRole("option", { name: new RegExp(`^Тестов ${escapedName}(?:\\s|$)`) }).click();
    await expect(marker).toHaveText(target.birth.slice(0, 4));
    const person = timeline.locator(`[data-person-id="${target.id}"] .timeline-person`);
    await expect.poll(async () => {
      const stage = await timeline.boundingBox(), card = await person.boundingBox();
      if (!stage || !card) return false;
      const centerY = card.y + card.height / 2;
      return centerY > stage.y + 86 && centerY < stage.y + stage.height &&
        card.x + card.width > stage.x && card.x < stage.x + stage.width;
    }, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(bounds.height * 10);
  });
  await mediaIdle();
  await snapshot("deep-person-settled");
  expect(mediaFailures).toBe(0);
  expect(errors).toEqual([]);
  const report = {
    date: new Date().toISOString(), tag, ...provenance,
    fixture: { people: count, seed: 5, generations: count === 977 ? 9 : 12,
      synthetic: true, dates: "birth=1750+parentDepth*20+(archiveIndex%7), January 1; no recorded deaths",
      inputHash: hash(JSON.stringify(family)), sourcePeopleWithBirth: family.people.filter((person) => person.birth).length,
      sparseYear: 1750, sparseEligible: timelineRowsAtYear(model.rows, 1750).length,
      fullYear: 2020, fullEligible: timelineRowsAtYear(model.rows, 2020).length,
      searchTarget: { id: target.id, birth: target.birth, rankAtBirthYear: targetRank } },
    device: { browser: page.context().browser()!.version(), gpu: gpu.devices, features: gpu.featureStatus,
      gpuAuxiliary: gpu.auxAttributes, project: testInfo.project.name, viewport: page.viewportSize(),
      cpuThrottle: throttle, angle: process.env.DREVO_E2E_ANGLE || "default",
      node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
    method: "Production build and real disposable SQLite/backend/JPEG previews. No response routing or renderer overrides. " +
      "Dates are setup HTTP mutations, excluded from measured phases. One run; no millisecond CI gates. " +
      "Gesture timings include Playwright input/polling and a two-frame boundary; 32ms input pacing is intentional. " +
      "DOM/rectangles sampled after the timed endpoint. Heap is main-thread JS only; excludes Worker/GPU/browser memory. " +
      (profile ? "CPU profiler enabled for horizontal-years: diagnostic, not a comparable timing run." : "CPU profiler disabled."),
    gestureSamples: { horizontalPerDirection, vertical: 16, pacingMs: 32 },
    phases, errors,
  };
  const json = JSON.stringify(report, null, 2);
  await writeFile(join(directory, name + ".json"), json);
  await testInfo.attach("timeline-performance", { body: json, contentType: "application/json" });
  await page.screenshot({ path: join(directory, name + ".png") });
  await session.detach();
});
