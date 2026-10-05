import { expect, test, type Page } from "@playwright/test";

const owner = {
  id: "operator",
  name: "Администратор",
  role: "relative",
  treeRole: "relative",
  approved: true,
  archiveOwner: true,
  platformAdmin: true,
  globalRole: "admin",
  aiAvailable: true,
};
const archives = [
  {
    id: "primary-tree",
    title: "Основной архив",
    current: true,
    approved: true,
    owned: true,
  },
  {
    id: "owned-alpha",
    title: "Архив Альфа",
    current: false,
    approved: true,
    owned: true,
  },
  {
    id: "owned-beta",
    title: "Архив Бета",
    current: false,
    approved: true,
    owned: true,
  },
  {
    id: "invited-tree",
    title: "Чужое дерево",
    current: false,
    approved: true,
    owned: false,
  },
  {
    id: "waiting-tree",
    title: "Ожидает допуска",
    current: false,
    approved: false,
    owned: true,
  },
];
async function platform(
  page: Page,
  session?: (path: string) => Partial<typeof owner>,
) {
  let familyReads = 0;
  await page.route("**/api/family**", (route) => {
    familyReads++;
    return route.fulfill({
      status: 403,
      json: { error: "No family load in platform" },
    });
  });
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        local: false,
        canEdit: true,
        yandex: false,
        vk: false,
        account: {
          id: "operator",
          name: "Администратор",
          fullAccess: true,
          globalRole: "admin",
        },
        user: {
          ...owner,
          ...session?.(new URL(route.request().url()).pathname),
        },
      },
    }),
  );
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({ json: { archives } }),
  );
  await page.route("**/api/platform/roles", (route) =>
    route.fulfill({ json: { accounts: [], next: null } }),
  );
  await page.route("**/api/platform/tiers**", (route) =>
    route.fulfill({
      json: {
        accounts: [],
        next: null,
        totals: { basic: 0, full: 0 },
      },
    }),
  );
  await page.goto("/admin");
  return () => familyReads;
}
function token(name: string) {
  return {
    id: "test-token",
    name,
    tokenHint: "test…hint",
    scopes: ["tree:read"],
    createdAt: "2026-10-05",
    createdBy: "operator",
    rateLimitPerMinute: 60,
    usage: { callsToday: 0, errorsToday: 0, averageLatencyMs: 0 },
  };
}
test("platform MCP selection scopes create/revoke and clears the prior secret", async ({
  page,
}, info) => {
  const paths: string[] = [];
  await page.route("**/api/mcp/tokens**", (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(`${route.request().method()} ${path}`);
    if (route.request().method() === "POST")
      return route.fulfill({
        status: 201,
        json: { token: "primary-test-secret", item: token("Созданный токен") },
      });
    if (route.request().method() === "DELETE")
      return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      json: {
        tokens: [
          token(
            path.includes("owned-alpha") ? "Токен Альфа" : "Основной токен",
          ),
        ],
        recentUsage: [],
      },
    });
  });
  const familyReads = await platform(page);
  await page.getByRole("button", { name: "MCP-токены", exact: true }).click();
  const select = page.getByLabel("Архив для MCP");
  await expect(select.getByRole("option")).toHaveText([
    "Основной архив",
    "Архив Альфа",
    "Архив Бета",
  ]);
  await expect(page.getByText("Основной токен", { exact: true })).toBeVisible();
  await expect(page.locator(".mcp-endpoint")).toHaveText("/mcp");
  await page
    .getByRole("button", { name: "Создать токен", exact: true })
    .click();
  await expect(
    page.getByText("primary-test-secret", { exact: true }),
  ).toBeVisible();
  await select.selectOption("owned-alpha");
  await expect(page.getByText("Токен Альфа", { exact: true })).toBeVisible();
  await expect(page.locator(".mcp-endpoint")).toHaveText("/a/owned-alpha/mcp");
  await expect(
    page.getByText("primary-test-secret", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("platform-mcp.png") });
  await page
    .getByRole("button", { name: "Создать токен", exact: true })
    .click();
  await expect
    .poll(() => paths)
    .toContain("POST /a/owned-alpha/api/mcp/tokens");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Отозвать токен: Токен Альфа" })
    .click();
  await expect
    .poll(() => paths)
    .toContain("DELETE /a/owned-alpha/api/mcp/tokens/test-token");
  expect(familyReads()).toBe(0);
});

test("late MCP list cannot repopulate another selected archive", async ({
  page,
}) => {
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  await page.route("**/api/mcp/tokens", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("owned-alpha")) {
      reached();
      await gate;
      await route
        .fulfill({
          json: { tokens: [token("Старый токен Альфа")], recentUsage: [] },
        })
        .catch(() => {});
      completed = true;
      return;
    }
    return route.fulfill({
      json: { tokens: [token("Текущий токен")], recentUsage: [] },
    });
  });
  await platform(page);
  await page.getByRole("button", { name: "MCP-токены", exact: true }).click();
  const select = page.getByLabel("Архив для MCP");
  await expect(page.getByText("Текущий токен", { exact: true })).toBeVisible();
  await select.selectOption("owned-alpha");
  await held;
  try {
    await select.selectOption("owned-beta");
    await expect(
      page.getByText("Текущий токен", { exact: true }),
    ).toBeVisible();
    release();
    await expect.poll(() => completed).toBe(true);
    await expect(
      page.getByText("Старый токен Альфа", { exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
});

test("fresh scoped permission denial and basic AI access do not load tokens", async ({
  page,
}) => {
  const paths: string[] = [];
  await page.route("**/api/mcp/tokens**", (route) => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { tokens: [], recentUsage: [] } });
  });
  await platform(page, (path) =>
    path.includes("owned-alpha")
      ? { archiveOwner: false }
      : { aiAvailable: false },
  );
  await page.getByRole("button", { name: "MCP-токены", exact: true }).click();
  await expect(
    page.getByText("ИИ-функции недоступны в выбранном архиве."),
  ).toBeVisible();
  await page.getByLabel("Архив для MCP").selectOption("owned-alpha");
  await expect(
    page.getByText("Доступ к управлению этим архивом изменился."),
  ).toBeVisible();
  expect(paths).toEqual([]);
});
