import test from "node:test";
import assert from "node:assert/strict";
import { lifespanStatistics } from "../src/domain/lifespan-statistics.ts";
import { executeResearchTool } from "../src/domain/research-tools.ts";
import { parseResearchMermaid } from "../src/domain/research-visual.ts";
import { normalizeResearchMarkdown } from "../src/domain/research-answer.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string, birth: string, death?: string): Person => ({
  id,
  name: id,
  surname: "Тестов",
  patronymic: "",
  sex: "u",
  birth,
  death,
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
});
test("lifespans include child deaths, exclude living and invalid dates, and retain uncertainty", () => {
  const family: Family = {
    demo: false,
    title: "Тест",
    description: "",
    people: [
      person("adult", "1900-07-10", "1980-07-09"),
      person("child", "1900-01-01", "1902-01-01"),
      person("partial", "1900", "1980"),
      person("living", "1991"),
      person("missing", "", "2000"),
      person("invalid", "1990-02-31", "2000"),
      person("backwards", "2000", "1999"),
    ],
  };
  const stats = lifespanStatistics(family);
  assert.equal(stats.sampleSize, 3);
  assert.equal(stats.approximateDates, 1);
  assert.deepEqual(stats.excluded, {
    missingDates: 2,
    invalidDates: 2,
    youngerThan18: 0,
  });
  assert.equal(stats.byGeneration[0].averageYears, 53.5);
  assert.equal(
    lifespanStatistics(family, true).byGeneration[0].averageYears,
    79.3,
  );
  const graph = parseResearchMermaid(stats.mermaid);
  assert.equal(graph.kind, "chart");
  if (graph.kind === "chart") {
    assert.deepEqual(graph.values, [53.5]);
    assert.deepEqual(graph.labels, ["1-е поколение (n=3)"]);
  }
  assert.throws(
    () =>
      executeResearchTool(family, "get_lifespan_statistics", {
        adultsOnly: "false",
      }),
    RangeError,
  );
  const quoted = parseResearchMermaid(
    'xychart\nx-axis ["Первая ветвь", "Вторая, младшая ветвь"]\nbar [1, 2]',
  );
  assert.equal(quoted.kind, "chart");
  if (quoted.kind === "chart")
    assert.deepEqual(quoted.labels, ["Первая ветвь", "Вторая, младшая ветвь"]);
  assert.equal(lifespanStatistics({ ...family, people: [] }).mermaid, "");
});
test("xychart language alias and unquoted multiword labels render without changing values", () => {
  const answer =
    '```xychart\n title "Жизнь"\n x-axis [1-е поколение, 2-е поколение, 3-е поколение]\n y-axis "Лет" 0 --> 80\n bar [67, 68, 47]\n```';
  const normalized = normalizeResearchMarkdown(answer);
  assert.match(normalized, /```mermaid\nxychart\n/);
  const visual = parseResearchMermaid(
    normalized.split("\n").slice(1, -1).join("\n"),
  );
  assert.equal(visual.kind, "chart");
  if (visual.kind === "chart") {
    assert.deepEqual(visual.labels, [
      "1-е поколение",
      "2-е поколение",
      "3-е поколение",
    ]);
    assert.deepEqual(visual.values, [67, 68, 47]);
  }
  assert.throws(
    () => parseResearchMermaid("xychart\nx-axis [a, b]\nbar [1]"),
    RangeError,
  );
  assert.throws(() => parseResearchMermaid("xychart\nbar [1, ]"), RangeError);
});
