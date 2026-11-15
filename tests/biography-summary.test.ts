import test from "node:test";
import assert from "node:assert/strict";
import { biographySummary } from "../src/domain/biography-summary.ts";

test("biography excerpt contains prose without link destinations, Markdown or GeoJSON", () => {
  const source = `## История\n\n**Учитель** [Александр](https://example.test/private) ${"работал в школе. ".repeat(50)}\n\n\`\`\`geojson\n{"type":"FeatureCollection","features":[]}\n\`\`\``;
  const excerpt = biographySummary(source)!;
  assert.ok(excerpt.startsWith("История Учитель Александр работал"));
  assert.ok(excerpt.endsWith("…"));
  assert.ok(excerpt.length <= 281);
  assert.doesNotMatch(excerpt, /example|geojson|FeatureCollection|\*\*/);
});

test("short prose and large map-only biographies stay directly accessible", () => {
  assert.equal(biographySummary("Короткая история."), null);
  assert.equal(biographySummary(`Боевой путь\n\n\`\`\`geojson\n${" ".repeat(1000)}\n\`\`\``), null);
});

test("GFM tables and strike-through are reduced to readable prose", () => {
  const excerpt = biographySummary(`~~Старая запись~~\n\n| Год | Место |\n| --- | --- |\n| 1946 | Школа |\n\n${"Семейные воспоминания. ".repeat(50)}`)!;
  assert.ok(excerpt.startsWith("Старая запись Год Место 1946 Школа"));
  assert.doesNotMatch(excerpt, /[|~]/);
});
