import { expect, test, type Page } from "@playwright/test";

const guest = { account: null, user: null, local: false, email: true };
const signedIn = { ...guest, account: { id: "signed-account" } };
const loginReason = "Войдите, чтобы искать опубликованных людей и открывать их карточки.";
const searchField = (page: Page) => page.getByRole("textbox", { name: "ФИО, год или место" });
const isPeopleRead = (url: URL) => /^\/api\/(?:discovery\/people|published-people)(?:\/|$)/.test(url.pathname);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const path of ["/discover", "/discover/search/Тестов", "/discover/person/tree-a/root",
  "/discover/person/local-root", "/discover?q=Тестов"]) {
  test(`guest cannot mount or query discovery at ${path}`, async ({ page }) => {
    let reads = 0;
    await page.route("**/api/session", (route) => route.fulfill({ json: guest }));
    await page.route(isPeopleRead, (route) => {
      reads += 1;
      return route.fulfill({ json: { results: [{ id: "private", name: "Закрытые данные" }] } });
    });
    await page.goto(path);
    await expect(page.getByText(loginReason)).toBeVisible();
    await expect(page.getByRole("button", { name: "Войти по почте" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Поиск опубликованных людей", exact: true })).toHaveCount(0);
    await expect(page.getByRole("search")).toHaveCount(0);
    await expect(searchField(page)).toHaveCount(0);
    await expect(page.locator(".public-person-card")).toHaveCount(0);
    expect(reads).toBe(0);
  });
}

test("pending session keeps a deep search unmounted, then accepts an account without membership", async ({ page }) => {
  const release = deferred();
  const seen = deferred();
  let reads = 0;
  await page.route("**/api/session", async (route) => {
    seen.resolve();
    await release.promise;
    await route.fulfill({ json: signedIn });
  });
  await page.route(isPeopleRead, (route) => {
    reads += 1;
    return route.fulfill({ json: { results: [{ archiveId: "tree-a", id: "root", name: "Разрешённая карточка" }] } });
  });
  try {
    await page.goto("/discover/search/Тестов");
    await seen.promise;
    await expect(page.getByRole("status")).toHaveText("Проверяем вход…");
    await expect(searchField(page)).toHaveCount(0);
    expect(reads).toBe(0);
    release.resolve();
    await expect(searchField(page)).toBeVisible();
    await expect(page.getByRole("link", { name: "Разрешённая карточка" })).toBeVisible();
    expect(reads).toBeGreaterThan(0);
  } finally { release.resolve(); }
});

for (const failure of ["503", "network"] as const) {
  test(`session ${failure} fails closed and can be retried`, async ({ page }) => {
    let failed = true;
    let reads = 0;
    await page.route("**/api/session", (route) => failed
      ? failure === "network" ? route.abort("failed") : route.fulfill({ status: 503, json: signedIn })
      : route.fulfill({ json: signedIn }));
    await page.route(isPeopleRead, (route) => {
      reads += 1;
      return route.fulfill({ json: { results: [] } });
    });
    await page.goto("/discover/search/Тестов");
    await expect(page.getByRole("alert")).toContainText("Не удалось проверить вход");
    await expect(searchField(page)).toHaveCount(0);
    expect(reads).toBe(0);
    failed = false;
    await page.getByRole("button", { name: "Повторить проверку" }).click();
    await expect(searchField(page)).toBeVisible();
    await expect(page.getByText("Никого не найдено.")).toBeVisible();
    expect(reads).toBeGreaterThan(0);
  });
}

for (const event of ["focus", "visibilitychange", "pageshow"] as const) {
  test(`valid session ${event} preserves the unsaved query while hiding the rechecked form`, async ({ page }) => {
    let delay = false;
    const release = deferred();
    const seen = deferred();
    const queries: string[] = [];
    await page.route("**/api/session", async (route) => {
      if (delay) { seen.resolve(); await release.promise; }
      await route.fulfill({ json: signedIn });
    });
    await page.route(isPeopleRead, (route) => {
      queries.push(new URL(route.request().url()).searchParams.get("q") || "");
      return route.fulfill({ json: { results: [{ id: "root", name: "Найденный человек" }] } });
    });
    try {
      await page.goto("/discover/search/Тестов");
      await expect(page.getByRole("link", { name: "Найденный человек" })).toBeVisible();
      await searchField(page).fill("Несохранённый запрос");
      delay = true;
      await page.evaluate((name) => (name === "visibilitychange" ? document : window).dispatchEvent(new Event(name)), event);
      await seen.promise;
      const field = page.locator("#public-person-query");
      await expect(field).toBeHidden();
      await expect(field).toHaveValue("Несохранённый запрос");
      await expect(field.locator("xpath=ancestor::div[@inert]")).toHaveAttribute("hidden");
      release.resolve();
      await expect(searchField(page)).toBeVisible();
      await expect(searchField(page)).toHaveValue("Несохранённый запрос");
      await expect(page.getByRole("link", { name: "Найденный человек" })).toBeVisible();
      expect(queries.every((query) => query === "Тестов")).toBe(true);
    } finally { release.resolve(); }
  });
}

for (const path of ["/discover/search/Тестов", "/discover/person/tree-a/root"]) {
  test(`logout on focus removes loaded personal data at ${path}`, async ({ page }) => {
    let loggedOut = false;
    let reads = 0;
    await page.route("**/api/session", (route) => route.fulfill({ json: loggedOut ? guest : signedIn }));
    await page.route("**/api/account/archives", (route) => route.fulfill({ json: { archives: [] } }));
    await page.route(isPeopleRead, (route) => {
      reads += 1;
      const person = { archiveId: "tree-a", id: "root", name: "Старые личные данные" };
      return route.fulfill({ json: { results: [person], person } });
    });
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Старые личные данные" })).toBeVisible();
    const readsBeforeLogout = reads;
    loggedOut = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText(loginReason)).toBeVisible();
    await expect(page.locator(".public-person-card")).toHaveCount(0);
    await expect(searchField(page)).toHaveCount(0);
    expect(reads).toBe(readsBeforeLogout);
  });
}

test("a search 401 clears earlier results even with an unreadable response body", async ({ page }) => {
  await page.route("**/api/session", (route) => route.fulfill({ json: signedIn }));
  await page.route(isPeopleRead, (route) => new URL(route.request().url()).searchParams.has("cursor")
    ? route.fulfill({ status: 401, body: "Session ended" })
    : route.fulfill({ json: { results: [{ id: "root", name: "Старые результаты" }], nextCursor: "next" } }));
  await page.goto("/discover/search/Тестов");
  await expect(page.getByRole("link", { name: "Старые результаты" })).toBeVisible();
  await page.getByRole("button", { name: "Показать ещё" }).click();
  await expect(page.getByText(loginReason)).toBeVisible();
  await expect(page.locator(".public-person-card")).toHaveCount(0);
  await expect(searchField(page)).toHaveCount(0);
});

test("a failed session recheck removes loaded results before retry", async ({ page }) => {
  let unavailable = false;
  await page.route("**/api/session", (route) => unavailable
    ? route.fulfill({ status: 503, json: signedIn }) : route.fulfill({ json: signedIn }));
  await page.route(isPeopleRead, (route) => route.fulfill({ json: {
    results: [{ id: "root", name: "Данные до сбоя" }],
  } }));
  await page.goto("/discover/search/Тестов");
  await expect(page.getByRole("link", { name: "Данные до сбоя" })).toBeVisible();
  unavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Не удалось проверить вход");
  await expect(page.locator(".public-person-card")).toHaveCount(0);
  await expect(searchField(page)).toHaveCount(0);
  unavailable = false;
  await page.getByRole("button", { name: "Повторить проверку" }).click();
  await expect(page.getByRole("link", { name: "Данные до сбоя" })).toBeVisible();
});

test("a detail 401 closes the form and card after a successful session check", async ({ page }) => {
  let unauthorized = false;
  await page.route("**/api/session", (route) => route.fulfill({ json: signedIn }));
  await page.route("**/api/account/archives", (route) => route.fulfill({ json: { archives: [] } }));
  await page.route(isPeopleRead, (route) => unauthorized
    ? route.fulfill({ status: 401, json: { error: "Войдите снова" } })
    : route.fulfill({ json: { person: { archiveId: "tree-a", id: "root", name: "Старая карточка" } } }));
  await page.goto("/discover/person/tree-a/root");
  await expect(page.getByRole("heading", { name: "Старая карточка" })).toBeVisible();
  unauthorized = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText(loginReason)).toBeVisible();
  await expect(page.locator(".public-person-card")).toHaveCount(0);
  await expect(searchField(page)).toHaveCount(0);
});

test("an outdated in-flight 401 cannot close a newly checked session", async ({ page }) => {
  const release = deferred();
  const seen = deferred();
  const completed = deferred();
  let refreshed = false;
  await page.route("**/api/session", (route) => route.fulfill({ json: signedIn }));
  await page.route(isPeopleRead, async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      seen.resolve();
      await release.promise;
      try { await route.fulfill({ status: 401, json: { error: "Старая сессия" } }); }
      finally { completed.resolve(); }
      return;
    }
    await route.fulfill({ json: { results: [{ id: "root", name: refreshed ? "Новая карточка" : "Старая карточка" }], nextCursor: "next" } });
  });
  try {
    await page.goto("/discover/search/Тестов");
    await expect(page.getByRole("link", { name: "Старая карточка" })).toBeVisible();
    await page.getByRole("button", { name: "Показать ещё" }).click();
    await seen.promise;
    refreshed = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("link", { name: "Новая карточка" })).toBeVisible();
    release.resolve();
    await completed.promise;
    await expect(searchField(page)).toBeVisible();
    await expect(page.getByRole("link", { name: "Новая карточка" })).toBeVisible();
    await expect(page.getByText(loginReason)).toHaveCount(0);
  } finally { release.resolve(); }
});
