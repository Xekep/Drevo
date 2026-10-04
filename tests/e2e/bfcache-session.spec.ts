import { chromium, expect, test, type Page } from "@playwright/test";

const origin = `http://127.0.0.1:${process.env.DREVO_E2E_PORT || 4173}`;

async function cachedPage() {
  // Playwright's default headless shell and flags disable BFCache. Use full
  // Chromium and native-document Back, as in a real Chrome session.
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : { channel: "chromium" }),
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
  });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as typeof window & { cacheRestores?: boolean[] }).cacheRestores = [];
    window.addEventListener("pageshow", (event) => {
      (window as typeof window & { cacheRestores: boolean[] }).cacheRestores.push(event.persisted);
    });
  });
  return { browser, page };
}

async function wasRestored(page: Page) {
  return page.evaluate(() =>
    (window as typeof window & { cacheRestores: boolean[] }).cacheRestores.at(-1));
}

async function expectRestored(page: Page) {
  try {
    await expect.poll(() => wasRestored(page)).toBe(true);
  } catch (error) {
    const navigation = await page.evaluate(() => {
      const entry = performance.getEntriesByType("navigation").at(-1) as
        (PerformanceNavigationTiming & { notRestoredReasons?: unknown }) | undefined;
      return { type: entry?.type, notRestoredReasons: entry?.notRestoredReasons };
    });
    throw new Error(`Native Back did not restore BFCache: ${JSON.stringify(navigation)}`, { cause: error });
  }
}

test("Back from platform settings revalidates a cached account and ignores late older sessions", async () => {
  const { browser, page } = await cachedPage();
  let fullAccess = true;
  let sessionReads = 0;
  let holdNextSession = false;
  let releaseOlderSession: (() => Promise<void>) | null = null;
  try {
    await page.route("**/api/family?projection=overview", (route) =>
      route.fulfill({ status: 401, json: { error: "Private archive" } }));
    await page.route("**/api/session", async (route) => {
      sessionReads++;
      const captured = fullAccess;
      if (holdNextSession) {
        holdNextSession = false;
        releaseOlderSession = () => route.fulfill({ json: session(captured) });
        return;
      }
      return route.fulfill({ json: session(captured) });
    });
    const session = (access: boolean) => ({
      user: null,
      account: { id: "platform-only", name: "Synthetic administrator",
        createdAt: "2026-10-04", fullAccess: access, globalRole: "admin", provider: "email" },
      local: false, yandex: false, vk: false, email: true,
    });
    await page.route("**/api/account/archives", (route) =>
      route.fulfill({ json: { archives: [] } }));
    await page.route("**/api/account/sessions", (route) =>
      route.fulfill({ json: { currentExpiresAt: null, otherCount: 0 } }));
    await page.route("**/api/platform/roles", (route) =>
      route.fulfill({ json: { accounts: [], next: null } }));
    await page.route(/\/api\/platform\/tiers(?:\/[^/?]+)?(?:\?.*)?$/, (route) => {
      if (route.request().method() === "PATCH") {
        fullAccess = (route.request().postDataJSON() as { fullAccess: boolean }).fullAccess;
        return route.fulfill({ json: { accountId: "platform-only", fullAccess, changed: true } });
      }
      return route.fulfill({ json: { accounts: [
        { id: "platform-only", name: "Synthetic administrator", fullAccess },
      ], next: null, totals: { basic: Number(!fullAccess), full: Number(fullAccess) } } });
    });
    await page.goto(`${origin}/account`);
    await expect(page.locator(".account-facts").first()).toContainText("Полный");
    await page.getByRole("button", { name: "Админка платформы" }).click();
    await page.getByLabel("Уровень доступа Synthetic administrator").selectOption("basic");
    await expect(page.getByLabel("Уровень доступа Synthetic administrator")).toHaveValue("basic");
    const beforeBack = sessionReads;
    await page.goBack({ waitUntil: "commit" });
    await expectRestored(page);
    await expect(page.locator(".account-facts").first()).toContainText("Базовый");
    expect(sessionReads).toBeGreaterThan(beforeBack);

    // A slower first validation cannot overwrite a newer result.
    holdNextSession = true;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect.poll(() => releaseOlderSession !== null).toBe(true);
    await expect(page.locator(".restored-session-gate:modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".restored-session-gate:modal")).toBeVisible();
    fullAccess = true;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(page.locator(".account-facts").first()).toContainText("Полный");
    await (releaseOlderSession as (() => Promise<void>) | null)?.();
    await expect(page.locator(".account-facts").first()).toContainText("Полный");

    releaseOlderSession = null;
    holdNextSession = true;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect.poll(() => releaseOlderSession !== null).toBe(true);
    // A normal view-triggered session read can supersede BFCache validation.
    await page.evaluate(() => {
      history.pushState(null, "", "/admin");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByRole("heading", { name: "Админка платформы" }).first()).toBeVisible();
    await expect(page.locator(".restored-session-gate")).toHaveCount(0);
    await (releaseOlderSession as (() => Promise<void>) | null)?.();
    await expect(page.locator(".restored-session-gate")).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test("cached scoped tree stays hidden on busy validation, then retains its graph on retry", async () => {
  const { browser, page } = await cachedPage();
  let fullAccess = true;
  const approved = true;
  let archiveOwner = true;
  let treeRole: "relative" | "reader" = "relative";
  let treeAccess: "all" | "common_ancestors" = "all";
  let failNextSession = false;
  let familyReads = 0;
  const sessionPaths: string[] = [];
  try {
    await page.route("**/a/tree-a/api/**", (route) => route.continue({
      url: route.request().url().replace("/a/tree-a/api/", "/api/"),
    }));
    await page.route("**/api/family?projection=overview", async (route) => {
      familyReads++;
      const response = await route.fetch({
        url: route.request().url().replace("/a/tree-a/api/", "/api/"),
      });
      const data = await response.json();
      return route.fulfill({ response, json: { ...data, local: false,
        user: { ...data.user, id: "owner", name: "Synthetic owner", role: "relative",
          treeRole: "relative", archiveOwner: true, approved: true,
          platformAdmin: true, globalRole: "admin", fullAccess: true, aiAvailable: true },
      } });
    });
    await page.route("**/api/session", (route) => {
      sessionPaths.push(new URL(route.request().url()).pathname);
      if (failNextSession && new URL(route.request().url()).pathname === "/a/tree-a/api/session") {
        failNextSession = false;
        return route.fulfill({ status: 409, json: { error: "Busy" } });
      }
      return route.fulfill({ json: {
        user: approved ? { id: "owner", name: "Synthetic owner", role: "relative",
          treeRole, archiveOwner, approved, platformAdmin: true,
          globalRole: "admin", treeAccess, fullAccess, aiAvailable: fullAccess } : null,
        account: { id: "owner", name: "Synthetic owner", createdAt: "2026-10-04",
          fullAccess, globalRole: "admin", provider: "email" },
        local: false, yandex: false, vk: false, email: true,
      } });
    });
    await page.route("**/api/account/archives", (route) =>
      route.fulfill({ json: { archives: [] } }));
    await page.route("**/api/platform/roles", (route) =>
      route.fulfill({ json: { accounts: [], next: null } }));
    await page.route(/\/api\/platform\/tiers(?:\/[^/?]+)?(?:\?.*)?$/, (route) => {
      if (route.request().method() === "PATCH") {
        fullAccess = (route.request().postDataJSON() as { fullAccess: boolean }).fullAccess;
        return route.fulfill({ json: { accountId: "owner", fullAccess, changed: true } });
      }
      return route.fulfill({ json: { accounts: [
        { id: "owner", name: "Synthetic owner", fullAccess },
      ], next: null, totals: { basic: Number(!fullAccess), full: Number(fullAccess) } } });
    });
    await page.goto(`${origin}/a/tree-a/tree`);
    const graph = page.locator(".react-flow__viewport");
    await expect(graph).toBeVisible();
    const transform = await graph.getAttribute("style");
    const beforeBackFamily = familyReads;
    await page.evaluate(() => {
      const modal = document.createElement("dialog");
      modal.id = "synthetic-private-modal";
      modal.textContent = "Private document preview";
      document.body.append(modal);
      modal.showModal();
    });
    await page.evaluate(() => window.location.assign("/admin"));
    const beforeTierSession = sessionPaths.length;
    await page.getByLabel("Уровень доступа Synthetic owner").selectOption("basic");
    await expect.poll(() => sessionPaths.length).toBeGreaterThan(beforeTierSession);
    failNextSession = true;
    await page.goBack({ waitUntil: "commit" });
    await expectRestored(page);
    await expect(page.getByRole("button", { name: "Повторить проверку" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Повторить проверку" })).toBeVisible();
    expect(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)
      ?.closest("dialog")?.classList.contains("restored-session-gate"))).toBe(true);
    await page.evaluate(() => document.getElementById("synthetic-private-modal")?.remove());
    await expect(graph).toBeHidden();
    expect(familyReads).toBe(beforeBackFamily);
    await page.getByRole("button", { name: "Повторить проверку" }).click();
    await expect(graph).toBeVisible();
    await expect(graph).toHaveAttribute("style", transform || "");
    expect(familyReads).toBe(beforeBackFamily);
    expect(sessionPaths).toContain("/a/tree-a/api/session");

    await page.evaluate(() => window.location.assign("/admin"));
    await page.locator("#platform-tiers-title").waitFor();
    archiveOwner = false;
    treeRole = "reader";
    await page.goBack({ waitUntil: "commit" });
    await expectRestored(page);
    await expect(graph).toBeVisible();
    await expect(graph).toHaveAttribute("style", transform || "");
    expect(familyReads).toBe(beforeBackFamily);

    await page.evaluate(() => window.location.assign("/admin"));
    await page.locator("#platform-tiers-title").waitFor();
    treeAccess = "common_ancestors";
    await page.goBack({ waitUntil: "commit" });
    await expectRestored(page);
    await expect(page.getByText("Права просмотра архива изменились.", { exact: false })).toBeVisible();
    await expect(graph).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test("cached unscoped private tree closes after completed logout", async () => {
  const { browser, page } = await cachedPage();
  let loggedOut = false;
  try {
    await page.route("**/api/family?projection=overview", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      return route.fulfill({ response, json: { ...data, local: false,
        user: { ...data.user, id: "former-owner", name: "Former owner",
          role: "relative", treeRole: "relative", archiveOwner: true,
          approved: true, treeAccess: "all", globalRole: "admin" },
      } });
    });
    await page.route("**/api/session", (route) => route.fulfill({ json: loggedOut ? {
      user: null, account: null, local: false, yandex: false, vk: false, email: true,
    } : {
      user: { id: "former-owner", name: "Former owner", role: "relative",
        treeRole: "relative", archiveOwner: true, approved: true,
        treeAccess: "all", globalRole: "admin", platformAdmin: true },
      account: { id: "former-owner", name: "Former owner", createdAt: "2026-10-04",
        fullAccess: true, globalRole: "admin", provider: "email" },
      local: false, yandex: false, vk: false, email: true,
    } }));
    await page.route("**/api/account/archives", (route) =>
      route.fulfill({ json: { archives: [] } }));
    await page.route("**/api/platform/roles", (route) =>
      route.fulfill({ json: { accounts: [], next: null } }));
    await page.goto(`${origin}/tree`);
    const graph = page.locator(".react-flow__viewport");
    await expect(graph).toBeVisible();
    await page.evaluate(() => window.location.assign("/admin"));
    await page.getByRole("heading", { name: "Админка платформы" }).first().waitFor();
    loggedOut = true;
    await page.goBack({ waitUntil: "commit" });
    await expectRestored(page);
    await expect(page.getByText("Доступ к семейному архиву изменился.", { exact: false })).toBeVisible();
    await expect(graph).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test("confirmed logout invalidates overview and detail responses that were pending at restoration", async () => {
  const { browser } = await cachedPage();
  try {
    for (const heldPart of ["overview", "detail"] as const) {
      const page = await browser.newPage();
      const upstream = await page.request.get(`${origin}/api/family?projection=overview`);
      const initial = await upstream.json();
      let releasePage: (() => Promise<void>) | null = null;
      await page.route("**/a/tree-a/api/**", (route) => route.continue({
        url: route.request().url().replace("/a/tree-a/api/", "/api/"),
      }));
      await page.route("**/a/tree-a/api/session", (route) => route.fulfill({ json: {
        user: null, account: null, local: false, yandex: false, vk: false, email: true,
      } }));
      await page.route("**/a/tree-a/api/family?projection=overview", (route) => {
        const fulfill = () => route.fulfill({ json: { ...initial, local: false,
          user: { id: "former-owner", name: "Former owner", role: "relative",
            treeRole: "relative", archiveOwner: true, approved: true, treeAccess: "all" },
        } });
        if (heldPart === "overview") { releasePage = fulfill; return; }
        return fulfill();
      });
      await page.route(/\/a\/tree-a\/api\/family\?projection=page&collection=people/, (route) => {
        if (heldPart === "detail") {
          releasePage = () => route.continue({
            url: route.request().url().replace("/a/tree-a/api/", "/api/"),
          });
          return;
        }
        return route.continue({ url: route.request().url().replace("/a/tree-a/api/", "/api/") });
      });
      await page.goto(`${origin}/a/tree-a/tree`);
      await expect.poll(() => releasePage !== null).toBe(true);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      await expect(page.getByText("Доступ к семейному архиву изменился.", { exact: false })).toBeVisible();
      try { await (releasePage as (() => Promise<void>) | null)?.(); } catch {
        // The archive read was aborted when the confirmed denial closed it.
      }
      await expect(page.locator(".react-flow__viewport")).toHaveCount(0);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
