import test from "node:test";
import assert from "node:assert/strict";
import { requesterRelationshipAnswer } from "../src/domain/research-relationship.ts";
import type { Family, Person } from "../src/domain/types.ts";

function person(
  id: string,
  surname: string,
  name: string,
  sex: Person["sex"],
  parents: string[] = [],
  spouses: string[] = [],
): Person {
  return {
    id,
    surname,
    name,
    patronymic: "",
    sex,
    birth: "",
    birthPlace: "",
    parents,
    spouses,
    generation: 0,
    column: 0,
    sources: [],
  };
}

const family: Family = {
  title: "Тестовый архив",
  description: "",
  demo: false,
  people: [
    person("root", "Чепчугов", "Павел", "m"),
    person("branch-a", "Чепчугов", "Максим", "m", ["root"]),
    person("branch-b", "Чепчугова", "Ирина", "f", ["root"]),
    person("parent-a", "Чепчугов", "Сергей", "m", ["branch-a"]),
    person("parent-b", "Красильникова", "Надежда", "f", ["branch-b"]),
    person("me", "Чепчугов", "Алексей", "m", ["parent-a"]),
    person("wife", "Красильникова", "Мария", "f", ["parent-b"], ["dmitry"]),
    person("dmitry", "Красильников", "Дмитрий", "m", [], ["wife"]),
    person("son", "Красильников", "Данил", "m", ["wife", "dmitry"]),
  ],
  photos: [],
};

const history = [
  { role: "user" as const, content: "Сколько у Дмитрия Красильникова детей?" },
  {
    role: "assistant" as const,
    content: "У Дмитрия есть ребёнок — Данил.",
    references: [
      { kind: "person", id: "dmitry", label: "Красильников Дмитрий" },
      { kind: "person", id: "son", label: "Красильников Данил" },
    ],
  },
];

test("a pronoun follow-up computes spouse-of-third-cousin kinship from the archive", () => {
  for (const prior of [
    history,
    [
      history[0],
      {
        role: "assistant" as const,
        content: "Данил — один из детей.",
        references: [{ kind: "person", id: "son", label: "Данил" }],
      },
    ],
  ]) {
    const result = requesterRelationshipAnswer(
      family,
      "me",
      "А кем я ему прихожусь?",
      prior,
    );
    assert.ok(result);
    assert.match(result.answer, /Красильников Дмитрий/);
    assert.match(result.answer, /Красильникова Мария/);
    assert.match(result.answer, /троюродная сестра/);
    assert.doesNotMatch(result.answer, /дед|бабушк|общих предков по линии/iu);
  }
});

test("without a linked requester or an unambiguous target the answer does not guess", () => {
  assert.match(
    requesterRelationshipAnswer(
      family,
      null,
      "А кем я ему прихожусь?",
      history,
    )!.answer,
    /привяжите аккаунт/,
  );
  assert.match(
    requesterRelationshipAnswer(family, "me", "А кем я ему прихожусь?", [])!
      .answer,
    /Не могу однозначно определить/,
  );
});

test("requester-relative kinship uses the correct direction", () => {
  const parentHistory = [
    { role: "user" as const, content: "Расскажи о Сергее Чепчугове" },
    {
      role: "assistant" as const,
      content: "Сергей Чепчугов найден.",
      references: [
        { kind: "person", id: "parent-a", label: "Чепчугов Сергей" },
      ],
    },
  ];
  assert.match(
    requesterRelationshipAnswer(
      family,
      "me",
      "Кем я ему прихожусь?",
      parentHistory,
    )!.answer,
    /сын/,
  );
  assert.match(
    requesterRelationshipAnswer(
      family,
      "me",
      "Кем мне приходится Сергей Чепчугов?",
      parentHistory,
    )!.answer,
    /отец/,
  );
});
