import { expect, test } from "@playwright/test";

test("администратор выбирает себя в древе и простую область доступа", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  let participant = {
    id: "relative-test",
    name: "Участник",
    role: "relative",
    approved: true,
    createdAt: "2026-01-01T00:00:00Z",
    personId: undefined as string | undefined,
    treeAccess: "all",
  };
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/users", (route) =>
    route.fulfill({ json: { users: [participant] } }),
  );
  await page.route("**/api/users/relative-test", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    participant = {
      ...participant,
      personId: String(submitted.personId),
      treeAccess: String(submitted.treeAccess),
    };
    await route.fulfill({ json: { users: [participant] } });
  });
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: { publicTree: false, publicAlbums: false, reverseTimeline: false },
    }),
  );
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Участники и роли" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Кто это в древе: Участник" })
    .fill("Иван");
  await page.getByRole("option", { name: /Иван Петрович/ }).click();
  await page
    .getByRole("combobox", { name: "Доступ к древу: Участник" })
    .selectOption("common_ancestors");
  await page.getByRole("button", { name: "Сохранить доступ" }).click();
  await expect
    .poll(() => submitted)
    .toEqual({
      personId: "e2e-memorial-person",
      treeAccess: "common_ancestors",
    });
  await expect(
    page.getByText("Собственные новые карточки видны участнику"),
  ).toBeVisible();
});

test("привязанный человек видит отметку «Это вы» в карточке", async ({
  page,
}) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = "e2e-memorial-person";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  await page
    .getByTestId("rf__node-e2e-memorial-person")
    .locator(".flow-person-content")
    .evaluate((card) => (card as HTMLElement).click());
  await expect(page.getByText("Это вы", { exact: true })).toBeVisible();
});

test("production build opens the archive and navigates without console errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/");
  await expect(page).toHaveTitle(/Древо/);
  await expect(
    page.getByRole("navigation", { name: "Разделы архива" }),
  ).toBeVisible();
  const people = page.getByRole("button", { name: "Люди", exact: true });
  if (!(await people.isVisible()))
    await page.locator('summary[aria-label="Меню проекта"]').click();
  await people.click();
  await expect(page.getByRole("heading", { name: /Люди/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("initial archive loading uses one quiet progress indicator", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/family**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const loader = page.getByRole("status", { name: "Загрузка архива" });
  await expect(loader).toBeVisible();
  await expect(loader.locator(".archive-loader-ring")).toHaveCSS(
    "animation-name",
    "archive-loader-spin",
  );
  await expect(page.getByText(/Открываем .*архив/i)).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Разделы архива" }),
  ).toBeVisible();
});

test("lazy archive sections use the same quiet progress indicator", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  let sectionRequested = false;
  await page.route(/\/assets\/people-catalog-[^/]+\.js$/, async (route) => {
    sectionRequested = true;
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  await page.goto("/people", { waitUntil: "domcontentloaded" });
  await expect.poll(() => sectionRequested).toBe(true);
  const loader = page.getByRole("status", { name: "Загрузка архива" });
  await expect(loader).toBeVisible();
  await expect(loader.locator(".archive-loader-ring")).toBeVisible();
  await expect(page.getByText(/Открываем раздел/i)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Люди/ })).toBeVisible();
});

test("mobile archive does not overflow the viewport", async ({ page }) => {
  await page.goto("/tree");
  await expect(
    page.getByRole("navigation", { name: "Разделы архива" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("common ancestors view keeps blood relatives and excludes the spouse", async ({
  page,
}) => {
  await page.goto("/tree");
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .evaluate((card) => (card as HTMLElement).click());
  const dock = page.getByRole("dialog", { name: "Выбранный объект" });
  if (await dock.isVisible())
    await dock.getByRole("button", { name: "Свернуть панель" }).click();
  await page.getByRole("button", { name: "Общие предки" }).click();
  await expect(page.locator(".tree-family-count")).toHaveText("5 из 6");
  await expect(page.getByTestId("rf__node-e2e-spouse")).toHaveCount(0);
  await expect(page.getByTestId("rf__node-e2e-sibling-child")).toBeAttached();
  await page.getByRole("button", { name: "Всё древо" }).click();
  await expect(page.locator(".tree-family-count")).toHaveCount(0);
});

test("manual map correction stays available when historical lookup is busy", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const notice =
    "Поиск исторических названий сейчас недоступен. Можно выбрать найденный вариант, указать точку на карте или повторить позже.";
  await page.route("**/api/places/locate**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") || "";
    await route.fulfill({
      json: { query, candidates: [], notice },
    });
  });

  await page.goto("/places");
  await page
    .getByRole("button", { name: /Москва/ })
    .first()
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: notice }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Указать на карте" }).click();
  await page
    .locator(".leaflet-container")
    .click({ position: { x: 120, y: 120 } });
  await expect(
    page.getByRole("status").filter({ hasText: notice }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Сохранить выбранную точку" }),
  ).toBeVisible();
});

test("same-name map candidates show their municipality", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const labels = [
    "Мурзинка, Горноуральский муниципальный округ, Свердловская область, Россия",
    "Мурзинка, Новоуральский городской округ, Свердловская область, Россия",
    "Мурзинка, муниципальный округ Среднеуральск, Свердловская область, Россия",
  ];
  await page.route("**/api/places/locate**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") || "";
    await route.fulfill({
      json: {
        query,
        candidates: query.startsWith("Мурзинка")
          ? labels.map((label, index) => ({
              label,
              name: "Мурзинка",
              lat: 57 + index / 10,
              lon: 60 + index / 10,
            }))
          : [],
      },
    });
  });

  await page.goto("/places");
  await page
    .getByRole("button", { name: /Москва/ })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Название для поиска" })
    .fill("Мурзинка, Свердловская область");
  await page.getByRole("button", { name: "Найти" }).click();
  for (const label of labels)
    await expect(page.getByRole("button", { name: label })).toBeVisible();
  await expect(page.locator(".map-candidates li")).toHaveCount(3);
});

test("mobile tree starts with readable family cards", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/tree");
  await page.locator(".flow-person").first().waitFor({ state: "visible" });
  await expect
    .poll(async () => {
      const card = await page.locator(".flow-person").first().boundingBox();
      return card?.width || 0;
    })
    .toBeGreaterThanOrEqual(130);
  await expect(page.locator(".flow-person").first()).toHaveClass(/is-compact/);
  await expect
    .poll(async () =>
      page
        .locator(".flow-person")
        .first()
        .evaluate((card) => {
          const strong = card.querySelector("strong");
          if (!strong) return 0;
          const scale = card.getBoundingClientRect().width / card.clientWidth;
          return Number.parseFloat(getComputedStyle(strong).fontSize) * scale;
        }),
    )
    .toBeGreaterThanOrEqual(12);
  expect(
    await page.locator(".flow-person").evaluateAll((cards) =>
      cards.some((card) => {
        const rect = card.getBoundingClientRect();
        return (
          rect.right > 0 &&
          rect.left < innerWidth &&
          rect.bottom > 0 &&
          rect.top < innerHeight
        );
      }),
    ),
  ).toBe(true);
});

test("the initial tree grows from roots toward descendants", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveClass(/is-growing/);
  const nodes = page.locator(".tree-grow-node");
  await expect(nodes).toHaveCount(7);
  const delays = await nodes.evaluateAll((items) =>
    items
      .map((item) => getComputedStyle(item).animationDelay)
      .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b)),
  );
  expect(delays).toEqual([
    "0s",
    "0.52s",
    "0.52s",
    "0.55s",
    "0.58s",
    "1.07s",
    "1.13s",
  ]);
  await expect(page.getByTestId("rf__node-e2e-child")).toHaveCSS(
    "animation-delay",
    "0.52s",
  );
  await expect(page.getByTestId("rf__node-e2e-spouse")).toHaveCSS(
    "animation-delay",
    "0.55s",
  );
  await expect(page.getByTestId("rf__node-e2e-sibling")).toHaveCSS(
    "animation-delay",
    "0.58s",
  );
  await expect(nodes.last()).toHaveCSS("animation-name", "tree-branch-reveal");
  await expect(nodes.last()).toHaveCSS("animation-duration", "0.28s");
  const firstGrowthEdge = page
    .locator(".tree-grow-edge .tree-edge-growth-path")
    .first();
  await expect(firstGrowthEdge).toHaveAttribute("pathLength", "1");
  await expect(firstGrowthEdge).toHaveCSS("animation-name", "tree-edge-draw");
  await expect(firstGrowthEdge).toHaveCSS("animation-duration", "0.24s");
  const firstFinalEdge = page
    .locator(".tree-grow-edge .tree-edge-final-path")
    .first();
  await expect(firstFinalEdge).not.toHaveAttribute("pathLength", "1");
  await expect(firstFinalEdge).toHaveCSS(
    "animation-name",
    "tree-edge-final-reveal",
  );
  const edgeDelays = await page
    .locator(".tree-grow-edge .tree-edge-growth-path")
    .evaluateAll((items) =>
      items
        .map((item) => getComputedStyle(item).animationDelay)
        .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b)),
    );
  expect(edgeDelays).toEqual([
    "0.28s",
    "0.34s",
    "0.55s",
    "0.83s",
    "0.89s",
    "1.41s",
  ]);
  const godparent = page.getByRole("button", {
    name: "Связь: Крёстный отец → крестница",
  });
  await expect(godparent).toHaveClass(/tree-grow-edge-label/);
  await expect(godparent).toHaveCSS("animation-name", "tree-edge-label-reveal");
  await expect(godparent).toHaveCSS("animation-delay", "1.65s");

  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width * 0.8;
  const y = box!.y + box!.height * 0.8;
  await expect(canvas).toHaveClass(/is-growing/);
  const viewport = page.locator(".react-flow__viewport");
  const transform = await viewport.getAttribute("style");
  const firstCard = await page
    .locator(".flow-person-content")
    .first()
    .boundingBox();
  expect(firstCard).not.toBeNull();
  await page.mouse.click(
    firstCard!.x + firstCard!.width / 2,
    firstCard!.y + firstCard!.height / 2,
  );
  await expect(page.locator(".flow-person.is-selected")).toHaveCount(0);
  for (const button of ["left", "right"] as const) {
    await page.mouse.move(x, y);
    await page.mouse.down({ button });
    await page.mouse.move(x - 30, y - 20, { steps: 3 });
    await page.mouse.up({ button });
  }
  await expect(viewport).toHaveAttribute("style", transform!);
  await expect(canvas).toHaveClass(/is-growing/);
  await expect(firstFinalEdge).toHaveCSS(
    "animation-name",
    "tree-edge-final-reveal",
  );
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });
  const finalPaths = page.locator(".tree-grow-edge .tree-edge-final-path");
  await expect(finalPaths).toHaveCount(6);
  expect(
    await finalPaths.evaluateAll((paths) =>
      paths.every((path) => {
        const style = getComputedStyle(path);
        return style.visibility === "visible" && Number(style.opacity) === 1;
      }),
    ),
  ).toBe(true);
  const godparentPath = page.locator(
    ".relationship-godparent .tree-edge-final-path",
  );
  expect(
    await godparentPath.evaluate(
      (path) => getComputedStyle(path).strokeDasharray,
    ),
  ).toContain("5px");
  await expect(
    page.locator(".relationship-godparent .tree-edge-growth-path"),
  ).toHaveCSS("marker-end", "none");
  expect(
    await godparentPath.evaluate((path) => getComputedStyle(path).markerEnd),
  ).not.toBe("none");
  const labelDistance = await godparent.evaluate((button) => {
    const path = document.querySelector<SVGPathElement>(
      ".relationship-godparent .tree-edge-final-path",
    );
    const matrix = path?.getScreenCTM();
    if (!path || !matrix) return Infinity;
    const rect = button.getBoundingClientRect();
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const length = path.getTotalLength();
    let nearest = Infinity;
    for (let i = 0; i <= 200; i++) {
      const point = path
        .getPointAtLength((length * i) / 200)
        .matrixTransform(matrix);
      nearest = Math.min(
        nearest,
        Math.hypot(point.x - center.x, point.y - center.y),
      );
    }
    return nearest;
  });
  expect(labelDistance).toBeLessThan(3);
  expect(
    await page
      .locator(".flow-person-content strong")
      .first()
      .evaluate((element) => getComputedStyle(element).userSelect),
  ).toBe("none");
  expect(
    await godparent.evaluate((element) => getComputedStyle(element).userSelect),
  ).toBe("none");
  const nameBox = await page
    .locator(".flow-person-content strong")
    .first()
    .boundingBox();
  expect(nameBox).not.toBeNull();
  await page.mouse.move(nameBox!.x + 2, nameBox!.y + nameBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    nameBox!.x + nameBox!.width - 2,
    nameBox!.y + nameBox!.height / 2,
  );
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await godparent.click();
  await expect(
    page.getByRole("complementary", { name: "Выбранный объект" }),
  ).toBeVisible();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator(".tree-grow-node").first()).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(
    page.locator(".tree-grow-edge .tree-edge-final-path").first(),
  ).toHaveCSS("animation-name", "none");
  await expect(
    page.locator(".tree-grow-edge .tree-edge-growth-path").first(),
  ).toHaveCSS("display", "none");
  await expect(godparent).toHaveCSS("animation-name", "none");
});

test("collapsing descendants moves the remaining cards smoothly", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });

  const child = page.getByTestId("rf__node-e2e-child");
  const sibling = page.getByTestId("rf__node-e2e-sibling");
  const before = await Promise.all([
    child.boundingBox(),
    sibling.boundingBox(),
  ]);
  await child.getByRole("button", { name: "Свернуть потомков" }).click();

  await expect(page.getByTestId("rf__node-e2e-grandchild")).toHaveCount(0);
  await expect(canvas).toHaveClass(/is-layout-settling/);
  await expect(child).toHaveCSS("transition-duration", "0.44s");
  const hasTransformTransition = await page
    .locator(
      "[data-testid='rf__node-e2e-child'], [data-testid='rf__node-e2e-sibling']",
    )
    .evaluateAll((nodes) =>
      nodes.some((node) =>
        node
          .getAnimations()
          .some(
            (animation) =>
              animation instanceof CSSTransition &&
              animation.transitionProperty === "transform",
          ),
      ),
    );
  expect(hasTransformTransition).toBe(true);

  await expect(canvas).not.toHaveClass(/is-layout-settling/, {
    timeout: 1_000,
  });
  const after = await Promise.all([child.boundingBox(), sibling.boundingBox()]);
  expect(
    after.some(
      (box, index) =>
        !!box &&
        !!before[index] &&
        Math.hypot(box.x - before[index]!.x, box.y - before[index]!.y) > 1,
    ),
  ).toBe(true);
});

test("mobile person card stays below the project menu and starts the memorial flight", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/tree");
  await page
    .getByRole("button", { name: /Тестов Иван Петрович/ })
    .first()
    .click();

  const card = page.getByRole("dialog", { name: "Выбранный объект" });
  await expect(card).toBeVisible();
  const dove = card.locator(".memorial-dove");
  await expect(dove).toHaveCSS("animation-name", "dove-leave");

  await page.locator('summary[aria-label="Меню проекта"]').click();
  const menu = page.locator(".nav-bottom");
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + Math.min(24, rect.height / 2);
      return document.elementFromPoint(x, y)?.closest(".nav-bottom") === node;
    }),
  ).toBe(true);
});

test("face assistant loads the versioned Human models", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const models = ["blazeface.bin", "facemesh.bin", "faceres.bin"].map((name) =>
    page.waitForResponse((response) =>
      response.url().endsWith(`/models/human-3.3.6/${name}`),
    ),
  );
  await page.goto("/photos");
  for (const response of await Promise.all(models))
    expect(response.ok()).toBe(true);
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});
