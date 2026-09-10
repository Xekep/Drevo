import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { archivePaths, archiveViewAt } from "../src/domain/archive-routes.ts";

const root = new URL("..", import.meta.url);

test("interesting data is a regular archive section on desktop and mobile", () => {
  assert.equal(archivePaths.insights, "/insights");
  assert.equal(archiveViewAt("/insights"), "insights");
  const navigation = readFileSync(
    new URL("src/components/archive-navigation.tsx", root),
    "utf8",
  );
  assert.equal((navigation.match(/\["insights", "Интересное", Sparkles\]/g) || []).length, 2);
});

test("secondary archive sections are code-split away from App", () => {
  const app = readFileSync(new URL("src/App.tsx", root), "utf8"),
    section = readFileSync(
      new URL("src/components/archive-section.tsx", root),
      "utf8",
    );
  assert.match(app, /<ArchiveSection/);
  assert.doesNotMatch(app, /from "\.\/components\/places-map"/);
  assert.match(section, /lazy\(\(\) => import\("\.\/places-map"\)\)/);
  assert.match(section, /lazy\(\(\) => import\("\.\/insights-page"\)\)/);
});
