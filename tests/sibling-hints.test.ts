import test from "node:test";
import assert from "node:assert/strict";
import {
  siblingHints,
  equivalentPatronymics,
  type Person,
} from "../src/domain/index.ts";

const p = (
  id: string,
  surname: string,
  name: string,
  patronymic: string,
  extra: Partial<Person> = {},
): Person => ({
  id,
  surname,
  name,
  patronymic,
  sex: "u",
  birth: "",
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
  ...extra,
});
test("sibling suggestions match gendered surnames and patronymics, birth surnames and spelling variants", () => {
  for (const [a, b] of [
    ["Иванович", "Ивановна"],
    ["Ильич", "Ильинична"],
    ["Никитич", "Никитовна"],
    ["Семёнович", "Семеновна"],
    ["Юрьевич", "Юрьевна"],
  ])
    assert.equal(equivalentPatronymics(a, b), true, `${a}/${b}`);
  for (const [a, b] of [
    ["", ""],
    ["И.", "И."],
    ["Иванович", "Петровна"],
    ["Иван", "Иван"],
    ["Семёнович", "Сергеевна"],
  ])
    assert.equal(equivalentPatronymics(a, b), false);
  const a = p("a", "Фёдоров", "Иван", "Ильич");
  const b = p("b", "Петрова", "Мария", "Ильинична", { maidenName: "Федорова" });
  const before = structuredClone([a, b]);
  assert.equal(siblingHints(a, [a, b])[0].person.id, "b");
  assert.match(siblingHints(a, [a, b])[0].reason, /предположение/);
  assert.deepEqual([a, b], before);
  const c = p("c", "Федорова", "Анна", "Ильинична", { maidenName: "Соколова" });
  assert.equal(siblingHints(a, [a, c]).length, 0);
});
test("known relationships, different fathers, duplicates and remote generations suppress sibling guesses", () => {
  const a = p("a", "Иванов", "Алексей", "Петрович", { birth: "1980" });
  const b = p("b", "Иванова", "Мария", "Петровна", { birth: "1982" });
  const f1 = p("f1", "Иванов", "Пётр", "Ильич", { sex: "m" });
  const f2 = p("f2", "Иванов", "Пётр", "Ильич", { sex: "m" });
  assert.equal(siblingHints(a, [a, b]).length, 1);
  assert.equal(
    siblingHints({ ...a, parents: [f1.id] }, [
      { ...b, parents: [f2.id] },
      f1,
      f2,
    ]).length,
    0,
  );
  assert.equal(
    siblingHints({ ...a, parents: [f1.id] }, [{ ...b, parents: [f1.id] }, f1])
      .length,
    0,
  );
  assert.equal(siblingHints(a, [{ ...b, spouses: [a.id] }]).length, 0);
  assert.equal(siblingHints(a, [{ ...b, parents: [a.id] }]).length, 0);
  assert.equal(siblingHints(a, [{ ...b, birth: "1900" }]).length, 0);
  assert.equal(siblingHints(a, [{ ...a, id: "duplicate" }]).length, 0);
  assert.equal(
    siblingHints(a, [b], [{ from: a.id, to: b.id, type: "adoptive_parent" }])
      .length,
    0,
  );
});
