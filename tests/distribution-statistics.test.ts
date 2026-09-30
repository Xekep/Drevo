import test from "node:test";
import assert from "node:assert/strict";
import { distributionStatistics } from "../src/domain/distribution-statistics.ts";
import { executeResearchTool } from "../src/domain/research-tools.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  name: "Имя",
  surname: "Фамилия",
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
  ...extra,
});
const family = (people: Person[]): Family => ({
  title: "Архив",
  description: "",
  demo: false,
  people,
});

test("Shannon entropy uses all known values, reports missing values and does not invent dates", () => {
  const data = family([
    person("1", { birth: "1901" }),
    person("2", { birth: "1902" }),
    person("3", { birth: "1903" }),
    person("4", { birth: "1915" }),
    person("5"),
  ]);
  const result = distributionStatistics(data, "birth_decade");
  assert.equal(result.sampleSize, 4);
  assert.equal(result.missing, 1);
  assert.ok(Math.abs(result.entropyBits! - 0.8112781244591328) < 1e-12);
  assert.equal(result.normalizedEntropy, result.entropyBits);
  assert.deepEqual(result.buckets, [
    { label: "1900", count: 3 },
    { label: "1910", count: 1 },
  ]);
});

test("empty and constant distributions are explicit; display truncation does not change calculation", () => {
  assert.equal(distributionStatistics(family([]), "sex").entropyBits, null);
  assert.equal(
    distributionStatistics(family([person("1"), person("2")]), "surname")
      .entropyBits,
    0,
  );
  const result = distributionStatistics(
    family(
      Array.from({ length: 120 }, (_, i) =>
        person(String(i), { surname: `Фамилия ${i}` }),
      ),
    ),
    "surname",
  );
  assert.equal(result.sampleSize, 120);
  assert.equal(result.buckets.length, 50);
  assert.equal(result.truncated, true);
  assert.ok(Math.abs(result.entropyBits! - Math.log2(120)) < 1e-12);
  assert.throws(
    () =>
      executeResearchTool(family([]), "get_distribution_statistics", {
        dimension: "eval(1)",
      }),
    /Неизвестный/,
  );
});

test("known parents count only relationships inside the provided authorized projection", () => {
  const result = distributionStatistics(
    family([person("child", { parents: ["private", "private"] })]),
    "known_parents",
  );
  assert.deepEqual(result.buckets, [{ label: "0", count: 1 }]);
});

test("evidence summary covers the complete sample while records are paginated", () => {
  const data = family(
    Array.from({ length: 120 }, (_, i) =>
      person(String(i), {
        sources:
          i >= 50
            ? [{ title: "Запись", type: "archive", reference: "Ф. 1" }]
            : [],
      }),
    ),
  );
  const result = executeResearchTool(data, "get_evidence_coverage", {
    offset: 100,
  }) as {
    total: number;
    records: unknown[];
    hasMore: boolean;
    summary: {
      peopleWithCardSources: number;
      peopleWithoutCardSources: number;
    };
    documentContentInspected: boolean;
  };
  assert.equal(result.total, 120);
  assert.equal(result.records.length, 20);
  assert.equal(result.hasMore, false);
  assert.equal(result.summary.peopleWithCardSources, 70);
  assert.equal(result.summary.peopleWithoutCardSources, 50);
  assert.equal(result.documentContentInspected, false);
});
