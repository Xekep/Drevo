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
  assert.equal(
    (navigation.match(/\["insights", "Сводка", ChartNoAxesCombined\]/g) || [])
      .length,
    2,
  );
});

test("resource directory replaces quality navigation while its direct route is retained", () => {
  assert.equal(archivePaths.quality, "/quality");
  assert.equal(archiveViewAt("/quality"), "quality");
  assert.equal(archivePaths.resources, "/resources");
  assert.equal(archiveViewAt("/resources"), "resources");
  const navigation = readFileSync(
    new URL("src/components/archive-navigation.tsx", root),
    "utf8",
  );
  assert.equal(
    (navigation.match(/\["resources", "Ресурсы", LibraryBig\]/g) || []).length,
    2,
  );
  assert.doesNotMatch(navigation, /\["quality",/);
  const insights = readFileSync(
    new URL("src/components/insights-page.tsx", root),
    "utf8",
  );
  assert.match(insights, /href="\/quality"/);
  const section = readFileSync(
    new URL("src/components/archive-section.tsx", root),
    "utf8",
  );
  assert.match(section, /import\("\.\/archive-quality-page"\)/);
  assert.match(section, /import\("\.\/research-resources-page"\)/);
});

test("secondary archive sections are code-split away from App", () => {
  const app = readFileSync(new URL("src/App.tsx", root), "utf8"),
    section = readFileSync(
      new URL("src/components/archive-section.tsx", root),
      "utf8",
    );
  assert.match(app, /<ArchiveSection/);
  assert.doesNotMatch(app, /from "\.\/components\/places-map"/);
  assert.match(section, /const PlacesMap = lazy/);
  assert.match(section, /import\("\.\/places-map"\)/);
  assert.match(section, /const InsightsPage = lazy/);
  assert.match(section, /import\("\.\/insights-page"\)/);
});
