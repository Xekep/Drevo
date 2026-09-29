import assert from "node:assert/strict";
import test from "node:test";
import { archiveReport } from "../src/domain/archive-report.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string, parents: string[] = []): Person => ({
  id,
  surname: "",
  name: id,
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  parents,
  spouses: [],
  generation: 0,
  column: 0,
  sources: [],
});
const parent = person("Мать");
parent.birth = "1960";
const root = person("Анна", [parent.id, "скрытый-родитель"]);
root.birth = "1985";
root.birthPlace = "Казань";
root.sources = [
  {
    title: "Метрическая запись",
    type: "архив",
    reference: "Ф.1",
    url: "https://example.test/1",
  },
];
root.events = [
  { id: "later", type: "work", title: "Работа", date: "2015", sources: [] },
  {
    id: "earlier",
    type: "education",
    title: "Учёба",
    date: "2002",
    sources: [],
  },
];
const spouse = person("Борис");
root.spouses = [spouse.id];
spouse.spouses = [root.id];
const child = person("Вера", [root.id]);
const unrelated = person("Чужой");
const family: Family = {
  title: "Тест",
  description: "",
  demo: false,
  people: [parent, root, spouse, child, unrelated],
};

const content = (kind: Parameters<typeof archiveReport>[1]) =>
  archiveReport(family, kind, root.id, 3)
    .sections.flatMap((section) => section.lines)
    .join("\n");

test("PDF report models use recorded facts and the visible family projection", () => {
  const card = content("person");
  assert.match(card, /Казань/);
  assert.match(card, /Ф\.1 · https:\/\/example\.test\/1/);
  assert.match(card, /Борис/);
  assert.doesNotMatch(card, /скрытый-родитель|Чужой/);

  const familyText = content("family");
  assert.match(familyText, /Мать/);
  assert.match(familyText, /Вера/);
  assert.doesNotMatch(familyText, /Чужой|скрытый-родитель/);

  const timeline = content("timeline");
  assert.ok(
    timeline.indexOf("2002 · Учёба") < timeline.indexOf("2015 · Работа"),
  );
  assert.match(timeline, /1985 · Рождение · Казань/);

  assert.match(content("ancestors"), /Мать/);
  assert.doesNotMatch(content("ancestors"), /Чужой|Вера/);
  assert.match(content("descendants"), /Вера/);
  assert.doesNotMatch(content("descendants"), /Чужой|\n1\. Мать/);
  assert.match(content("research"), /Мать: место рождения, источники карточки/);
  assert.doesNotMatch(content("research"), /Чужой|скрытый-родитель/);
  const oneGeneration = archiveReport(family, "research", root.id, 1)
    .sections.flatMap((section) => section.lines)
    .join("\n");
  assert.match(oneGeneration, /Предки и опорный человек: 1/);
  assert.doesNotMatch(oneGeneration, /Мать:/);
  assert.throws(() =>
    archiveReport(family, "person", unrelated.id + "-hidden"),
  );
});
