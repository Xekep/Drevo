import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let origin: string;
test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      request.url === "/target"
        ? "<!doctype html><title>Target</title><h1>Целевая страница</h1>"
        : '<!doctype html><title>Links</title><a href="/target">Открыть ссылку</a>',
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

for (const gesture of ["middle", "modifier"] as const) {
  test(`native ${gesture} click opens a tab without application JavaScript`, async ({
    page,
    context,
  }) => {
    test.info().annotations.push({
      type: "issue",
      description: "https://github.com/microsoft/playwright/issues/42142",
    });
    // A pure browser default action separates tab initialization failures from
    // the application's notification, routing and read-receipt handlers.
    await page.goto(`${origin}/source`);
    const opened = context.waitForEvent("page");
    await page
      .getByRole("link", { name: "Открыть ссылку" })
      .click(
        gesture === "middle"
          ? { button: "middle" }
          : { modifiers: ["ControlOrMeta"] },
      );
    const target = await opened;
    try {
      await expect(target).toHaveURL(`${origin}/target`);
      await expect(target.getByRole("heading")).toHaveText("Целевая страница");
      await expect(page).toHaveURL(`${origin}/source`);
    } finally {
      await target.close();
    }
  });
}
