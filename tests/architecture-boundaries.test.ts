import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);

test("App delegates secondary pages instead of importing their implementations", () => {
  const app = readFileSync(new URL("src/App.tsx", root), "utf8"),
    section = readFileSync(
      new URL("src/components/archive-section.tsx", root),
      "utf8",
    );
  assert.match(app, /from "\.\/components\/archive-section"/);
  for (const module of [
    "people-catalog",
    "families-catalog",
    "gallery",
    "places-map",
  ])
    assert.doesNotMatch(app, new RegExp(`components\\/${module}`));
  assert.match(section, /const PeopleCatalog = lazy/);
  assert.match(section, /const FamiliesCatalog = lazy/);
  assert.match(section, /const Gallery = lazy/);
  assert.match(section, /const PlacesMap = lazy/);
  assert.match(section, /const InsightsPage = lazy/);
});
