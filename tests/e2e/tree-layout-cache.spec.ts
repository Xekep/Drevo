import { expect, test, type Page } from "@playwright/test";
import { randomFamily } from "../layout-fixtures";

test("medium tree edits pass the previous geometry to the layout worker", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const people = randomFamily(5, 4);
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
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
  await page.addInitScript(() => {
    const requests: { people: number; previous: number }[] = [];
    Object.assign(window, { __layoutHistoryRequests: requests });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown, transfer: Transferable[] | StructuredSerializeOptions = []) {
        if (message && typeof message === "object" && "people" in message && "mode" in message) {
          const request = message as { people: unknown[]; previousGeometry?: { positions: unknown[] } };
          requests.push({ people: request.people.length, previous: request.previousGeometry?.positions.length || 0 });
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
  });
  const requests = () => page.evaluate(() =>
    (window as typeof window & { __layoutHistoryRequests: { people: number; previous: number }[] })
      .__layoutHistoryRequests);
  // Open the ancestor at a readable scale: the distant overview deliberately
  // omits individual branch controls, so it is not an editing surface.
  await page.goto("/people/g-0-0");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/, { timeout: 30_000 });
  await expect.poll(async () => (await requests()).length).toBe(1);
  const collapse = page.getByTestId("rf__node-g-0-0").getByRole("button", { name: /Свернуть/ });
  await collapse.click();
  await expect.poll(async () => (await requests()).length).toBe(2);
  const history = await requests();
  expect(history[0].people).toBeGreaterThan(100);
  expect(history[1].people).toBeGreaterThan(100);
  expect(history[1].people).toBeLessThanOrEqual(200);
  expect(history[1].previous).toBeGreaterThan(100);
});

async function observeLayouts(page: Page) {
  await page.addInitScript(() => {
    const state = { requests: 0 };
    Object.assign(window, { __layoutCacheTest: state });
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
          "mode" in message
        )
          state.requests++;
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
  });
}
const requests = (page: Page) =>
  page.evaluate(
    () =>
      (window as typeof window & { __layoutCacheTest: { requests: number } })
        .__layoutCacheTest.requests,
  );
const stored = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("drevo-layout-cache", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("layouts");
          const count = tx.objectStore("layouts").count();
          count.onsuccess = () => resolve(count.result);
          tx.oncomplete = () => db.close();
        };
      }),
  );
async function ready(page: Page) {
  await expect(page.getByTestId("rf__node-e2e-child")).toBeAttached();
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-grow|is-layout-settling/,
  );
}

test("selection does not recalculate and reopening a branch reuses complete geometry", async ({
  page,
}) => {
  await observeLayouts(page);
  await page.goto("/people/e2e-child");
  await ready(page);
  expect(await requests(page)).toBe(1);
  await expect.poll(() => stored(page)).toBe(1);
  await page.evaluate(() => {
    history.pushState(null, "", "/people/e2e-memorial-person");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator(".inspector-dock")).toContainText("Иван");
  await page.evaluate(() => {
    history.pushState(null, "", "/people/e2e-child");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator(".inspector-dock")).toContainText("Пётр");
  expect(await requests(page)).toBe(1);
  const child = page.getByTestId("rf__node-e2e-child");
  await page.locator(".inspector-dock")
    .getByRole("button", { name: "Закрыть панель", exact: true }).click();
  await child
    .getByRole("button", { name: /Свернуть (потомков|ветвь)/ })
    .click();
  await expect(page.getByTestId("rf__node-e2e-grandchild")).toHaveCount(0);
  await ready(page);
  expect(await requests(page)).toBe(2);
  await child
    .getByRole("button", { name: /Развернуть (потомков|ветвь)/ })
    .click();
  await expect(page.getByTestId("rf__node-e2e-grandchild")).toBeAttached();
  await ready(page);
  expect(await requests(page)).toBe(2);
});

test("reload uses persistent geometry; changed birth and access policy require fresh layouts", async ({
  page,
}) => {
  await observeLayouts(page);
  let change: "none" | "birth" | "access" = "none";
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (change === "birth")
      data.family.people.find(
        (p: { id: string }) => p.id === "e2e-child",
      ).birth = "1966-02-03";
    if (change === "access") data.user.id = "different-user";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/people/e2e-child");
  await ready(page);
  await expect.poll(() => stored(page)).toBe(1);
  await page.reload();
  await ready(page);
  expect(await requests(page)).toBe(0);
  change = "birth";
  await page.reload();
  await ready(page);
  expect(await requests(page)).toBe(1);
  change = "access";
  await page.reload();
  await ready(page);
  expect(await requests(page)).toBe(1);
});

test("damaged persistent geometry falls back to a fresh calculation", async ({
  page,
}) => {
  await observeLayouts(page);
  await page.goto("/people/e2e-child");
  await ready(page);
  await expect.poll(() => stored(page)).toBe(1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("drevo-layout-cache", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("layouts", "readwrite");
          const store = tx.objectStore("layouts");
          const records = store.getAll();
          records.onsuccess = () => {
            for (const record of records.result)
              store.put({ ...record, value: "broken" });
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.reload();
  await ready(page);
  expect(await requests(page)).toBe(1);
});

test("disabled IndexedDB does not prevent rendering the tree", async ({
  page,
}) => {
  await observeLayouts(page);
  await page.addInitScript(() => {
    indexedDB.open = () => {
      throw new Error("Storage disabled");
    };
  });
  await page.goto("/people/e2e-child");
  await ready(page);
  expect(await requests(page)).toBe(1);
});

test("a stalled IndexedDB open cannot hold up the tree", async ({ page }) => {
  await observeLayouts(page);
  await page.addInitScript(() => {
    indexedDB.open = () => ({}) as IDBOpenDBRequest;
  });
  await page.goto("/people/e2e-child");
  await ready(page);
  expect(await requests(page)).toBe(1);
});
