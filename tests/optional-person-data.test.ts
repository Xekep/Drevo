import test from "node:test";
import assert from "node:assert/strict";
import {
  ageLabel,
  analyzeKinship,
  connectPeople,
  dateLabel,
  edgeLabel,
  graphLayout,
  splitFullName,
  validateFamily,
  years,
  type Family,
  type Person,
} from "../src/domain/index.ts";
import { openArchive } from "../src/server/database.ts";

const person = (id: string, birth = "", sex: Person["sex"] = "u"): Person => ({
  id,
  surname: "Тестов",
  name: id,
  patronymic: "",
  birth,
  sex,
  birthPlace: "",
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
});
const family = (...people: Person[]): Family => ({
  title: "Архив",
  description: "",
  demo: false,
  people,
});

test("a person can be saved with only a name; missing dates never produce age, birth year or inferred surname", () => {
  const p = { ...person("new"), ...splitFullName("  Иванова   Анна  ") };
  const store = openArchive(":memory:", family());
  try {
    store.write(family(p), store.read().revision);
    const saved = store.read().family.people[0];
    assert.equal(saved.name, "Анна");
    assert.equal(saved.patronymic, "");
    assert.equal(saved.birth, "");
    assert.equal(saved.sex, "u");
    assert.equal(saved.maidenName, undefined);
    assert.equal(years(saved), "");
    assert.equal(ageLabel(saved), "");
    assert.equal(dateLabel(saved.birth), "");
    assert.equal(years({ ...saved, death: "1985" }), "† 1985");
    assert.equal(ageLabel({ ...saved, death: "1985" }), "");
  } finally {
    store.close();
  }
});

test("unknown dates allow real parent links and adoption while known contradictions and cycles still fail", () => {
  const data = connectPeople(
    family(person("parent", "1950", "f"), person("child")),
    "parent",
    "child",
    "parent",
  );
  assert.equal(
    analyzeKinship(data.people[0], data.people[1], data.people).roles![0].term,
    "мать",
  );
  assert.equal(
    analyzeKinship(data.people[0], data.people[1], data.people).roles![1].term,
    "ребёнок",
  );
  assert.throws(() => connectPeople(data, "child", "parent", "parent"), /цикл/);
  data.people[1].birth = "1940";
  assert.throws(() => validateFamily(data), /раньше/);
  data.people[1].birth = "";
  data.people[0].birth = "";
  assert.doesNotThrow(() =>
    connectPeople(data, "parent", "child", "adoptive_parent"),
  );
  data.people[1].birth = "2100";
  assert.throws(() => validateFamily(data));
  data.people[1].birth = "1900-02-31";
  assert.throws(() => validateFamily(data));
});

test("unknown sex keeps relationship labels neutral, including a shared parent and relatives through marriage", () => {
  const parent = person("parent"),
    a = person("a", "", "m"),
    b = person("b"),
    spouse = person("spouse");
  a.parents = b.parents = [parent.id];
  a.spouses = [spouse.id];
  spouse.spouses = [a.id];
  const data = validateFamily(family(parent, a, b, spouse));
  assert.equal(edgeLabel(a, parent), "родитель");
  assert.equal(edgeLabel(parent, b), "ребёнок");
  assert.equal(edgeLabel(a, spouse), "супруг / супруга");
  const siblings = analyzeKinship(a, b, data.people);
  assert.equal(siblings.roles![0].term, "брат");
  assert.equal(siblings.roles![1].term, "брат / сестра");
  assert.doesNotMatch(siblings.roles![0].description, /Общий отец|Общая мать/);
  assert.equal(
    analyzeKinship(parent, spouse, data.people).roles![0].term,
    "родитель супруга",
  );
});

test("undated people occupy a separate area with distinct positions and remain connected in both timeline directions", () => {
  const a = person("parent"),
    b = person("child"),
    c = person("sibling"),
    d = person("dated", "1960");
  b.parents = c.parents = [a.id];
  for (const reverse of [false, true]) {
    const layout = graphLayout([a, b, c, d], 1830, reverse);
    const positions = [a, b, c].map((p) => layout.positions.get(p.id)!);
    assert.ok(
      positions.every(
        (p) =>
          Number.isFinite(p.x) &&
          Number.isFinite(p.y) &&
          p.y + 110 < layout.offset,
      ),
    );
    assert.equal(new Set(positions.map((p) => `${p.x}:${p.y}`)).size, 3);
    assert.equal(positions[0].y < positions[1].y, !reverse);
    assert.ok(layout.positions.get(d.id)!.y > layout.offset);
    const updated = graphLayout(
      [a, { ...b, birth: "1950" }, c, d],
      1830,
      reverse,
    );
    assert.ok(updated.positions.get(b.id)!.y > updated.offset);
    assert.equal(b.birth, "", "раскладка не записывает оценочные даты в архив");
  }
});
