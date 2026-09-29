import assert from "node:assert/strict";
import test from "node:test";
import { lineageReport } from "../src/domain/lineage-report.ts";
import type { Person } from "../src/domain/types.ts";

const make = (id: string, parents: string[] = []) =>
  ({
    id,
    name: id,
    surname: "",
    patronymic: "",
    birth: "",
    birthPlace: "",
    sex: "u",
    parents,
    spouses: [],
    generation: 1,
    column: 0,
    sources: [],
  }) as Person;
const grandparent = make("Бабушка");
grandparent.birth = "1930";
grandparent.sources = [
  {
    title: "Метрическая книга",
    type: "архив",
    reference: "Ф.1, Оп.2",
    url: "https://example.test/record",
  },
];
const parent = make("Мама", [grandparent.id]);
const root = make("Вера", [parent.id]);
const child = make("Сын", [root.id]);
const family = {
  people: [grandparent, parent, root, child, make("Посторонний")],
};

test("lineage text follows recorded generations and sources without unrelated people", () => {
  const ancestors = lineageReport(family, root.id, "ancestors", 3);
  assert.match(ancestors, /Роспись предков: Вера/);
  assert.match(ancestors, /Поколение 3\n1\. Бабушка \(1930\)/);
  assert.match(ancestors, /Ф\.1, Оп\.2 · https:\/\/example\.test\/record/);
  assert.doesNotMatch(ancestors, /Посторонний|Сын/);
  const descendants = lineageReport(family, root.id, "descendants", 2);
  assert.match(descendants, /Поколение 2\n1\. Сын/);
  assert.doesNotMatch(descendants, /Бабушка|Посторонний/);
  assert.equal(descendants, lineageReport(family, root.id, "descendants", 2));
  assert.throws(() => lineageReport(family, "missing", "ancestors", 2));
});
