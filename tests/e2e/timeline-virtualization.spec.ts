import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Person } from "../../src/domain/types";

function peopleFixture(count = 400): Person[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `window-${String(index).padStart(3, "0")}`,
    surname: "Тестов",
    name: `Окно ${String(index).padStart(3, "0")}`,
    patronymic: "",
    sex: "u",
    birth: index < count / 2 ? "1950-01-01" : "1980-01-01",
    birthPlace: "",
    parents: [],
    spouses: [],
    sources: [],
    generation: 1,
    column: index,
    ...(index === 0
      ? {
          events: [
            {
              id: "study",
              type: "education",
              title: "Учёба",
              date: "1970-09-01",
              place: "Москва",
            },
            {
              id: "move",
              type: "move",
              title: "Переезд",
              date: "1970-10-01",
              place: "Тверь",
            },
          ],
        }
      : {}),
  }));
}

async function fixture(
  page: Page,
  people = peopleFixture(),
  reducedMotion = true,
) {
  await page.emulateMedia({
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await page.addInitScript(() => {
    const state = window as typeof window & { timelineLayoutRequests?: number };
    state.timelineLayoutRequests = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(
        message: unknown,
        transfer: Transferable[] | StructuredSerializeOptions = [],
      ) {
        if (
          message &&
          typeof message === "object" &&
          "people" in message &&
          Array.isArray(message.people) &&
          "mode" in message
        )
          state.timelineLayoutRequests!++;
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.family.people = people;
    data.family.links = [];
    data.family.unions = [];
    data.family.photos = [];
    data.partial = false;
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-layout-people",
    String(people.length),
  );
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-grow|is-layout-settling/,
    { timeout: 30_000 },
  );
}

async function enterTimeline(page: Page) {
  await page
    .getByRole("button", { name: "Хронология", exact: true })
    .or(page.getByRole("switch", { name: "Древо / Хронология" }))
    .click();
  const timeline = page.getByRole("region", {
    name: /Горизонтальная хронология/,
  });
  await expect(timeline).toBeVisible();
  return timeline;
}

async function year(page: Page, timeline: Locator, target: number) {
  await timeline.evaluate((element, value) => {
    const current = Number(
      document.querySelector(".timeline-center-marker output")?.textContent,
    );
    element.scrollLeft += (value - current) * 12;
  }, target);
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText(
    String(target),
  );
}

const row = (timeline: Locator, id: string) =>
  timeline.locator(`.timeline-person-row[data-person-id="${id}"]`);

async function expectInViewport(
  timeline: Locator,
  id: string,
  centered = false,
) {
  await expect
    .poll(async () => {
      const viewport = await timeline.boundingBox();
      const person = await row(timeline, id)
        .locator(".timeline-person")
        .boundingBox();
      if (!viewport || !person) return false;
      const center = person.y + person.height / 2;
      return (
        center > viewport.y + 86 &&
        center < viewport.y + viewport.height - 36 &&
        (!centered || Math.abs(center - viewport.y - viewport.height / 2) < 40)
      );
    })
    .toBe(true);
}

async function expectBounded(timeline: Locator, count: number) {
  await expect(timeline).toHaveAttribute("data-timeline-people", String(count));
  await expect
    .poll(() => timeline.locator(".timeline-person-row").count())
    .toBeLessThan(64);
  await expect
    .poll(() =>
      timeline.evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        return Array.from(
          element.querySelectorAll(".timeline-person-row:not(.is-exiting)"),
        ).some((item) => {
          const bounds = item.getBoundingClientRect();
          return (
            bounds.bottom > viewport.top + 86 &&
            bounds.top < viewport.bottom - 36
          );
        });
      }),
    )
    .toBe(true);
}

test("large chronology bounds mounted rows, preserves the tree camera and finds an off-window person", async ({
  page,
}) => {
  await fixture(page);
  const camera = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  const geometry = await page
    .locator(".react-flow__node")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute("data-id"),
        style: node.getAttribute("style"),
      })),
    );
  const requests = await page.evaluate(
    () =>
      (window as typeof window & { timelineLayoutRequests?: number })
        .timelineLayoutRequests,
  );
  let timeline = await enterTimeline(page);
  await year(page, timeline, 2020);
  await expectBounded(timeline, 400);
  await expect(page.locator(".timeline-center-marker > span")).toContainText(
    "400 человек",
  );
  await expect(
    page.locator(".react-flow__node, .react-flow__edge"),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Древо", exact: true })
    .or(page.getByRole("switch", { name: "Древо / Хронология" }))
    .click();
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
    "style",
    camera!,
  );
  await expect
    .poll(() =>
      page.locator(".react-flow__node").evaluateAll((nodes) =>
        nodes.map((node) => ({
          id: node.getAttribute("data-id"),
          style: node.getAttribute("style"),
        })),
      ),
    )
    .toEqual(geometry);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { timelineLayoutRequests?: number })
          .timelineLayoutRequests,
    ),
  ).toBe(requests);

  timeline = await enterTimeline(page);
  await year(page, timeline, 2020);
  await expect(row(timeline, "window-399")).toHaveCount(0);
  await page.getByRole("combobox", { name: /Найти человека/ }).fill("Окно 399");
  await page.getByRole("option", { name: /^Тестов Окно 399(?:\s|$)/ }).click();
  await expectInViewport(timeline, "window-399");
  expect(
    await timeline.evaluate(
      (element) => element.scrollTop / element.clientHeight,
    ),
  ).toBeGreaterThan(10);
  await expectBounded(timeline, 400);

  await year(page, timeline, 1950);
  await expectBounded(timeline, 200);
  await expect(timeline.locator(".timeline-person-row.is-exiting")).toHaveCount(
    0,
  );
  const visibleIds = await timeline
    .locator(".timeline-person-row")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-person-id")),
    );
  expect(visibleIds.every((id) => Number(id?.slice(-3)) < 200)).toBe(true);
  await year(page, timeline, 2020);
  await expectBounded(timeline, 400);
});

test("virtual rows retain event details and keyboard focus across unmounts and row-height breakpoints", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop keyboard and the 899px row-height breakpoint");
  await fixture(page);
  const timeline = await enterTimeline(page);
  await year(page, timeline, 1970);
  await expect(timeline.locator(".timeline-event-list")).toHaveCount(0);
  const events = row(timeline, "window-000")
    .locator(".timeline-event")
    .filter({
      has: page.locator('summary[aria-label="1970: Учёба, Переезд"]'),
    });
  await events.locator("summary").click();
  await expect(events).toHaveAttribute("open", "");
  await expect(events.locator(".timeline-event-list")).toContainText("Москва");
  await expect(events.locator(".timeline-event-list")).toContainText("Тверь");
  await expect(events.locator(".timeline-event-list")).toContainText(
    "1 сентября 1970",
  );
  await expect(events.locator(".timeline-event-list")).toContainText(
    "1 октября 1970",
  );
  // Release focus so the open event really unmounts instead of being pinned.
  await timeline.focus();
  await timeline.evaluate((element) => {
    element.scrollTop = 6400;
  });
  await expect(row(timeline, "window-000")).toHaveCount(0);
  await timeline.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(events).toHaveAttribute("open", "");
  await expect(events.locator(".timeline-event-list")).toBeVisible();
  await events.locator("summary").click();

  await expect(events.locator(".timeline-event-list")).toHaveCount(0);
  const first = row(timeline, "window-000").locator(".timeline-person");
  await first.focus();
  await timeline.evaluate((element) => {
    element.scrollTop = 6400;
  });
  await expect(first).toBeFocused();
  await expectBounded(timeline, 200);
  await page.keyboard.press("ArrowDown");
  await expect(
    row(timeline, "window-001").locator(".timeline-person"),
  ).toBeFocused();
  await expectInViewport(timeline, "window-001");
  await page.keyboard.press("ArrowUp");
  await expect(first).toBeFocused();

  // Last overscan row has a successor in the archive, but not in the DOM.
  await timeline.focus();
  await timeline.evaluate((element) => {
    element.scrollTop = 6400;
  });
  await expectInViewport(timeline, "window-100");
  const lastId = await timeline
    .locator(".timeline-person-row")
    .last()
    .getAttribute("data-person-id");
  const nextId = `window-${String(Number(lastId!.slice(-3)) + 1).padStart(3, "0")}`;
  await expect(row(timeline, nextId)).toHaveCount(0);
  await row(timeline, lastId!)
    .locator("summary")
    .last()
    .evaluate((element) =>
      (element as HTMLElement).focus({ preventScroll: true }),
    );
  await page.keyboard.press("Tab");
  await expect(row(timeline, nextId).locator(".timeline-person")).toBeFocused();
  await expectInViewport(timeline, nextId);
  await page.keyboard.press("Shift+Tab");
  await expect(row(timeline, lastId!).locator("summary").last()).toBeFocused();

  await page.setViewportSize({ width: 850, height: 720 });
  await expect
    .poll(() =>
      timeline
        .locator(".timeline-person-row")
        .first()
        .evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBe(62);
  await expectBounded(timeline, 200);
  await expect(row(timeline, lastId!).locator("summary").last()).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect
    .poll(() =>
      timeline
        .locator(".timeline-person-row")
        .first()
        .evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBe(64);
  await expectBounded(timeline, 200);
  const styles = await timeline
    .locator(".timeline-person-row")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        height: node.getBoundingClientRect().height,
        animation: getComputedStyle(node).animationName,
      })),
    );
  expect(
    styles.every((style) => style.height === 64 && style.animation === "none"),
  ).toBe(true);
});

test("smooth focus remains on its person while intervening historical rows appear", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop smooth scrolling focus and inspector resizing");
  const people = peopleFixture();
  for (let index = 0; index < people.length; index++) {
    people[index].birth =
      index < 60 ? "1920-01-01" : index < 360 ? "1930-01-01" : "1950-01-01";
    if (index >= 60 && index < 360) people[index].death = "2000-01-01";
  }
  await fixture(page, people, false);
  const timeline = await enterTimeline(page);
  await year(page, timeline, new Date().getFullYear());
  await expectBounded(timeline, 100);
  await page.getByRole("combobox", { name: /Найти человека/ }).fill("Окно 380");
  await page.getByRole("option", { name: /^Тестов Окно 380(?:\s|$)/ }).click();
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1950");
  await expectBounded(timeline, 400);
  await expectInViewport(timeline, "window-380", true);
  // Observe after the exit/scroll/inspector animation deadlines, not only once
  // while the requested row passes through the viewport.
  await page.waitForTimeout(900);
  await expectInViewport(timeline, "window-380", true);
});

test("small chronology retains animated row collapse instead of virtual spacers", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop animation contract");
  await fixture(page, peopleFixture(16), false);
  const timeline = await enterTimeline(page);
  await year(page, timeline, 2020);
  await expect(
    timeline.locator(".timeline-person-row:not(.is-exiting)"),
  ).toHaveCount(16);
  await expect(timeline.locator(".timeline-row-spacer")).toHaveCount(0);
  const collapsed = await timeline.evaluate(async (element) => {
    const current = Number(
      document.querySelector(".timeline-center-marker output")?.textContent,
    );
    element.scrollLeft += (1950 - current) * 12;
    const samples: number[] = [];
    // Read actual animation frames before the 260ms removal timer.
    for (let frame = 0; frame < 9; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const exiting = element.querySelector(".timeline-person-row.is-exiting");
      if (exiting) samples.push(exiting.getBoundingClientRect().height);
    }
    return samples;
  });
  expect(collapsed.some((height) => height > 0 && height < 64)).toBe(true);
  await expect(timeline.locator(".timeline-person-row")).toHaveCount(8);
  await expect(timeline.locator(".timeline-row-spacer")).toHaveCount(0);
});
