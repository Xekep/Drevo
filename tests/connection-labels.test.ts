import test from "node:test";
import assert from "node:assert/strict";
import {
  connectionPairName,
  connectionRoleName,
} from "../src/domain/connection-labels.ts";

const man = { sex: "m" as const, name: "Иван", patronymic: "" };
const woman = { sex: "f" as const, name: "Анна", patronymic: "" };
const unknown = { sex: "u" as const, name: "Саша", patronymic: "" };

test("step-parent names follow both recorded sexes", () => {
  assert.equal(connectionPairName("step_parent", man, woman), "Отчим → падчерица");
  assert.equal(connectionPairName("step_parent", woman, man), "Мачеха → пасынок");
  assert.equal(connectionPairName("step_parent", man, woman, true), "Падчерица ← отчим");
  assert.equal(connectionRoleName("step_parent", woman), "мачеха");
});

test("additional relationships show both roles on an edge", () => {
  assert.equal(connectionPairName("godparent", woman, man), "Крёстная мать → крестник");
  assert.equal(connectionPairName("adoptive_parent", man, woman), "Приёмный отец → приёмная дочь");
  assert.equal(connectionPairName("sworn_sibling", woman, man), "Названая сестра ↔ названый брат");
});

test("unknown sex remains neutral, but a reliable name hint resolves the role", () => {
  assert.equal(connectionPairName("step_parent", unknown, unknown), "Супруг родителя → пасынок или падчерица");
  assert.equal(
    connectionRoleName("step_parent", { sex: "u", name: "Мария", patronymic: "" }),
    "мачеха",
  );
});
