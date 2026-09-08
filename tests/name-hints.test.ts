import test from "node:test";
import assert from "node:assert/strict";
import {
  guessSex,
  resolvedSex,
  matchesPatronymic,
  parentHints,
  birthSurnameHints,
  surnameForSex,
  marriageHints,
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

test("saved co-parents suggest a marriage question without creating a marriage or duplicates", () => {
  const father = person("Иван"),
    mother = person("Мария"),
    child = person("Анна", { parents: [father.id, mother.id] }),
    other = person("Пётр", { parents: [father.id, mother.id] });
  const data = archive(father, mother, child, other),
    before = structuredClone(data);
  const hints = marriageHints(father, data.people);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].person.id, mother.id);
  assert.equal(hints[0].children.length, 2);
  assert.deepEqual(data, before);
  const married = connectPeople(data, father.id, mother.id, "spouse");
  assert.equal(marriageHints(married.people[0], married.people).length, 0);
  assert.equal(matchesPatronymic("Митрофан", "Митрофанович"), true);
  assert.equal(guessSex(person("Митрофан")), "m");
  assert.equal(guessSex(person("Алёна")), "f");
  assert.equal(matchesPatronymic("Афанасий", "Афанасьевна"), true);
});

test("name matching handles pasted whitespace, yo and less common full names without inventing patronymics", () => {
  for (const [name, patronymic] of [
    ["\u00a0Артемий\u00a0", "Артемьевна"],
    ["Артур", "Артуровна"],
    ["Моисей", "Моисеевич"],
    ["Елисей", "Елисеевна"],
    ["Давид", "Давидовна"],
    ["Дмитрий", "Дмитриевна"],
    ["Фё\u200bдор", "Федорович"],
  ]) {
    const father = person("father", { name });
    const child = person("child", { name: "Анна", patronymic });
    assert.ok(
      parentHints(child, [father]).some((h) => h.from === father.id),
      `${name}: ${patronymic}`,
    );
  }
  assert.equal(matchesPatronymic("Дмитрий", "Дмитрьевна"), false);
  assert.equal(matchesPatronymic("Юрий", "Юриевич"), false);
  assert.equal(matchesPatronymic("Артём", "Артемьевич"), false);
  assert.equal(matchesPatronymic("Иван", "Петрович"), false);
});

test("birth surname outranks a married surname and unambiguous compound surnames are preserved", () => {
  const father = person("father", { name: "Иван", surname: "Соколов-Петров" });
  const namesake = person("namesake", { name: "Иван", surname: "Андреев" });
  const child = person("child", {
    name: "Анна",
    surname: "Андреева",
    maidenName: " Соколова ‑ Петрова ",
    patronymic: "Ивановна",
  });
  const hints = parentHints(child, [namesake, father]);
  assert.equal(hints[0].from, father.id);
  assert.match(hints[0].reason, /фамилия при рождении/);
  assert.equal(surnameForSex("Соколов‑Петров", "f"), "Соколова-Петрова");
  assert.equal(surnameForSex("Кийко-Иванова", "m"), "Кийко-Иванов");
  assert.equal(surnameForSex("Цой-Иванов", "f"), null);
  const suggested = birthSurnameHints(
    { ...child, maidenName: "", parents: [father.id] },
    [father],
  );
  assert.equal(suggested[0].surname, "Соколова-Петрова");
});

test("an undated known brother, ancestor or adoptive descendant cannot become a suggested father", () => {
  const mother = person("mother", { name: "Мария" });
  const brother = person("brother", { name: "Иван", parents: [mother.id] });
  const child = person("child", {
    name: "Анна",
    patronymic: "Ивановна",
    parents: [mother.id],
  });
  assert.equal(parentHints(child, [mother, brother]).length, 0);
  const grandparent = person("grandparent", { name: "Иван" });
  const unknown = person("unknown", { parents: [grandparent.id] });
  assert.equal(
    parentHints({ ...child, parents: [unknown.id] }, [grandparent, unknown])
      .length,
    0,
  );
  const father = person("father", { name: "Иван" });
  const unrelatedChild = { ...child, parents: [] };
  assert.equal(parentHints(unrelatedChild, [father]).length, 1);
  assert.equal(
    parentHints(
      unrelatedChild,
      [father],
      [{ type: "adoptive_parent", from: child.id, to: father.id }],
    ).length,
    0,
  );
  assert.equal(
    parentHints({ ...unrelatedChild, death: "1950" }, [
      { ...father, birth: "1960" },
    ]).length,
    0,
  );
});

test("mother suggestions use recorded co-parenthood, work both ways and still require confirmation", () => {
  const father = person("father", { name: "Иван", birth: "1960" });
  const mother = person("mother", { name: "Мария", birth: "1962" });
  const sibling = person("sibling", {
    name: "Пётр",
    parents: [father.id, mother.id],
  });
  const child = person("child", {
    name: "Анна",
    birth: "1990",
    patronymic: "Ивановна",
    parents: [father.id],
  });
  const people = [father, mother, sibling, child],
    before = structuredClone(people);
  const hints = parentHints(child, people);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].role, "mother");
  assert.equal(hints[0].from, mother.id);
  assert.match(hints[0].reason, /единокровными/);
  assert.ok(
    parentHints(mother, people).some(
      (h) => h.role === "child" && h.to === child.id,
    ),
  );
  assert.deepEqual(people, before);
  for (const patch of [
    { parentageComplete: true },
    { parents: [father.id, mother.id] },
    { birth: "1970" },
    { birth: "2020" },
  ])
    assert.equal(
      parentHints({ ...child, ...patch }, people).filter(
        (h) => h.role === "mother",
      ).length,
      0,
    );
  assert.equal(
    parentHints(
      child,
      people.map((p) => (p.id === mother.id ? { ...p, death: "1980" } : p)),
    ).length,
    0,
  );
  assert.equal(
    parentHints(child, [
      { ...father, spouses: [mother.id] },
      { ...mother, spouses: [father.id] },
      child,
    ]).length,
    0,
  );
});

test("partial dates remain possible while precise dates rule out contradictory parent hints", () => {
  const father = person("father", {
    name: "Иван",
    birth: "1960",
    death: "1989-01-01",
  });
  const child = person("child", {
    name: "Анна",
    patronymic: "Ивановна",
    birth: "1990-12-01",
  });
  assert.equal(parentHints(child, [father]).length, 0);
  assert.equal(
    parentHints({ ...child, birth: "1990" }, [{ ...father, death: "1989" }])
      .length,
    1,
  );
  assert.equal(
    parentHints({ ...child, birth: "1974-01-01" }, [
      { ...father, birth: "1960-12-01", death: undefined },
    ]).length,
    0,
  );
  const mother = person("mother", {
    name: "Мария",
    birth: "1960",
    death: "1990-01-01",
  });
  const sibling = person("sibling", { parents: [father.id, mother.id] });
  const data = [{ ...father, death: undefined }, mother, sibling];
  assert.equal(parentHints({ ...child, parents: [father.id] }, data).length, 0);
});
