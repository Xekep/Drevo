import test from "node:test";
import assert from "node:assert/strict";
import {
  guessSex,
  resolvedSex,
  matchesPatronymic,
  parentHints,
  birthSurnameHints,
  surnameForSex,
  analyzeKinship,
  edgeLabel,
  connectPeople,
  type Person,
  type Family,
} from "../src/domain/index.ts";
const person = (id: string, patch: Partial<Person> = {}): Person => ({
  id,
  surname: "Тестов",
  name: id,
  patronymic: "",
  birth: "",
  sex: "u",
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  column: 0,
  generation: 1,
  ...patch,
});
const archive = (...people: Person[]): Family => ({
  title: "Проверка",
  description: "",
  demo: false,
  people,
});

test("name hints respect explicit sex, ambiguous names and contradictory name parts", () => {
  assert.equal(guessSex(person("Анна")), "f");
  assert.equal(guessSex(person("Илья")), "m");
  assert.equal(guessSex(person("Саша")), "u");
  assert.equal(guessSex(person("Женя", { surname: "Иванова" })), "u");
  assert.equal(guessSex(person("Женя", { patronymic: "Ильинична" })), "f");
  assert.equal(guessSex(person("Мария", { patronymic: "Иванович" })), "u");
  assert.equal(resolvedSex(person("Анна", { sex: "m" })), "m");
});
test("patronymics cover common exceptions and spelling variants", () => {
  for (const [name, patronymic] of [
    ["Павел", "Павловна"],
    ["Илья", "Ильинична"],
    ["Никита", "Никитич"],
    ["Яков", "Яковлевич"],
    ["Савва", "Саввична"],
    ["Геннадий", "Геннадьевна"],
    ["Геннадий", "Геннадиевна"],
    ["Сергей", "Сергеевич"],
    ["Фёдор", "Федоровна"],
  ])
    assert.equal(matchesPatronymic(name, patronymic), true, patronymic);
  assert.equal(matchesPatronymic("Сергей", "Сергеович"), false);
  assert.equal(matchesPatronymic("Пётр", "Павлович"), false);
  assert.equal(matchesPatronymic("Саша", "Александрович"), false);
});
test("old unspecified cards recover in-law names without a data migration", () => {
  const mother = person("Анна"),
    son = person("Иван", { parents: [mother.id], spouses: ["Ольга"] }),
    wife = person("Ольга", { spouses: [son.id] });
  const data = archive(mother, son, wife),
    before = structuredClone(data);
  assert.equal(
    analyzeKinship(mother, wife, data.people).roles![0].term,
    "свекровь",
  );
  assert.equal(
    analyzeKinship(mother, wife, data.people).roles![1].term,
    "невестка",
  );
  assert.equal(edgeLabel(son, mother), "мать");
  assert.deepEqual(data, before);
});
test("unknown shared parent does not erase dever and zolovka terms", () => {
  const parent = person("unknown"),
    husband = person("husband", {
      sex: "m",
      parents: [parent.id],
      spouses: ["reference"],
    }),
    brother = person("brother", { sex: "m", parents: [parent.id] }),
    reference = person("reference", { spouses: [husband.id] });
  assert.equal(
    analyzeKinship(reference, brother, [parent, husband, brother, reference])
      .roles![1].term,
    "деверь",
  );
  const sister = { ...brother, sex: "f" as const };
  assert.equal(
    analyzeKinship(reference, sister, [parent, husband, sister, reference])
      .roles![1].term,
    "золовка",
  );
});
test("svat depends on the subject, not the unknown sex of the married children", () => {
  const a = person("a"),
    child = person("child", { parents: [a.id], spouses: ["partner"] }),
    partner = person("partner", { parents: ["other"] }),
    other = person("other", { sex: "m" });
  assert.equal(
    analyzeKinship(a, other, [a, child, partner, other]).roles![1].term,
    "сват",
  );
});
test("parent hints find both directions and preserve candidates until confirmation", () => {
  const father = person("father", {
      name: "Иван",
      surname: "Кийко",
      birth: "1960",
    }),
    namesake = person("namesake", {
      name: "Иван",
      surname: "Петров",
      birth: "1965",
    }),
    child = person("child", {
      name: "Анна",
      surname: "Кийко",
      patronymic: "Ивановна",
      birth: "1990",
    });
  const original = archive(father, namesake, child),
    before = structuredClone(original);
  assert.deepEqual(
    parentHints(child, original.people).map((h) => h.from),
    [father.id, namesake.id],
  );
  assert.equal(parentHints(father, original.people)[0].role, "child");
  assert.deepEqual(original, before);
  const confirmed = connectPeople(original, father.id, child.id, "parent");
  assert.deepEqual(confirmed.people[2].parents, [father.id]);
  assert.equal(parentHints(confirmed.people[2], confirmed.people).length, 0);
});
test("parent suggestions exclude impossible dates, complete families, known fathers and cycles", () => {
  const father = person("father", { name: "Иван", birth: "1970" }),
    child = person("child", {
      name: "Анна",
      patronymic: "Ивановна",
      birth: "1995",
    });
  for (const patch of [
    { birth: "1960" },
    { birth: "1975" },
    { birth: "2050" },
    { parentageComplete: true },
    { parents: ["father"] },
  ])
    assert.equal(parentHints({ ...child, ...patch }, [father]).length, 0);
  assert.equal(parentHints(child, [{ ...father, death: "1990" }]).length, 0);
  assert.equal(
    parentHints(child, [{ ...father, parents: [child.id] }]).length,
    0,
  );
  const other = person("other", { sex: "m" });
  assert.equal(
    parentHints({ ...child, parents: [other.id] }, [father, other]).length,
    0,
  );
  assert.equal(
    parentHints({ ...child, patronymic: "Петровна" }, [father]).length,
    0,
  );
  assert.equal(
    parentHints({ ...child, birth: "" }, [{ ...father, birth: "" }]).length,
    1,
  );
});
test("birth surnames are suggestions from an indicated father, never invented or overwritten", () => {
  const father = person("father", { name: "Иван", surname: "Соколов" }),
    daughter = person("daughter", {
      name: "Анна",
      surname: "Петрова",
      parents: [father.id],
    });
  const before = structuredClone(daughter);
  assert.equal(birthSurnameHints(daughter, [father])[0].surname, "Соколова");
  assert.deepEqual(daughter, before);
  assert.equal(
    birthSurnameHints({ ...daughter, parents: [] }, [father]).length,
    0,
  );
  assert.equal(
    birthSurnameHints({ ...daughter, maidenName: "Иванова" }, [father]).length,
    0,
  );
  assert.equal(surnameForSex("Кийко", "f"), "Кийко");
  assert.equal(surnameForSex("Достоевский", "f"), "Достоевская");
  assert.equal(surnameForSex("Цой", "f"), null);
});
test("godparents yield personal terms and kumovstvo with unspecified legacy sex", () => {
  const father = person("Иван"),
    godmother = person("Мария"),
    child = person("Анна", { parents: [father.id] });
  const data = connectPeople(
    archive(father, godmother, child),
    godmother.id,
    child.id,
    "godparent",
  );
  assert.equal(
    analyzeKinship(godmother, child, data.people, data.links).roles![0].term,
    "крёстная мать",
  );
  assert.equal(
    analyzeKinship(father, godmother, data.people, data.links).roles![1].term,
    "кума",
  );
});
