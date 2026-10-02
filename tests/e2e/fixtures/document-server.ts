import { test as base } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../src/server/index.ts";

// Each scenario owns a temporary archive and its upload quota.
export const test = base.extend<{ documentServer: string }>({
  // Playwright requires a destructuring pattern even for a fixture without dependencies.
  // eslint-disable-next-line no-empty-pattern
  documentServer: async ({}, provide) => {
    const directory = mkdtempSync(join(tmpdir(), "drevo-document-e2e-"));
    const app = await startServer(0, join(directory, "drevo.sqlite"), true);
    try {
      await provide(
        `http://127.0.0.1:${(app.server.address() as { port: number }).port}`,
      );
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  baseURL: async ({ documentServer }, provide) => provide(documentServer),
});

test.beforeEach(async ({ page }) => {
  const csp = readFileSync("ops/nginx.conf", "utf8").match(
    /add_header Content-Security-Policy "([^"]+)"/,
  )![1];
  await page.route("**/documents", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": csp },
    });
  });
});
