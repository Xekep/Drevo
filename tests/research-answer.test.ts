import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanPdfAnswer,
  linkResearchReferences,
  normalizeResearchMarkdown,
  replaceResearchTable,
  researchPdfFilename,
  verifiedSurnameTable,
} from "../src/domain/research-answer.ts";

test("repairs malformed surname table and empty diagram using verified genealogy", () => {
  const source =
    "| ФИОДата рожденияМесто рожденияДата смертиПримечания | | | | |\n| --- | --- | --- | --- | --- |\n| Иван | — | — | — | Отец |\n```mermaid\n```\nНе удалось построить схему";
  const result = normalizeResearchMarkdown(
    source,
    'graph TD\n  n0["Иван"]',
    true,
  );
  assert.match(
    result,
    /^\| ФИО \| Дата рождения \| Место рождения \| Дата смерти \| Примечания \|/,
  );
  assert.match(result, /```mermaid\ngraph TD\n/);
  assert.doesNotMatch(result, /Не удалось построить схему/);
});

test("surname table uses archived fields and clickable people regardless of model formatting", () => {
  const table = verifiedSurnameTable([{ id: "person-1", name: "Родина Анна", birthSurname: "Чепчугова", birth: "1930", birthPlace: "", death: null }]);
  const answer = replaceResearchTable("Ветвь:\n\n| Слитый заголовок | |\n| --- | --- |\n| неточно | неточно |\n\nПроверено.", table);
  assert.match(answer, /\| ФИО \| Фамилия при рождении \| Дата рождения \| Место рождения \| Дата смерти \|/);
  assert.match(answer, /\[\[person:person-1\|Родина Анна\]\] \| Чепчугова \| 1930 \| — \| —/);
  assert.doesNotMatch(answer, /неточно|Слитый заголовок/);
});

test("ссылка на готовый PDF остаётся только у вложения, имя короткое", () => {
  assert.equal(
    cleanPdfAnswer(
      "Готово, отчёт приложен. Вы можете скачать файл по ссылке: ``",
    ),
    "Готово, отчёт приложен.",
  );
  assert.equal(
    cleanPdfAnswer(
      "Отчёт готов. Скачать файл можно по ссылке: /api/ai/files/7449c409-8874-4739-8574-158fab22f458",
    ),
    "Отчёт готов.",
  );
  assert.equal(
    researchPdfFilename(
      "Анализ семейного архива: род Чепчуговых и связанные семьи",
    ),
    "Анализ семейного архива.pdf",
  );
});

test("все проверенные ФИО и уникальные короткие формы становятся ссылками", () => {
  const references = Array.from({ length: 18 }, (_, index) => ({
    kind: "person" as const,
    id: `person-${index}`,
    label: `Фамилия${index} Имя${index} Отчество${index}`,
  }));
  const answer =
    "Фамилия17 Имя17 Отчество17 и Имя16 Фамилия16 и Фамилия15 Имя15.";
  const linked = linkResearchReferences(answer, references);
  assert.match(
    linked,
    /\[Фамилия17 Имя17 Отчество17\]\(#drevo-person-person-17\)/,
  );
  assert.match(linked, /\[Имя16 Фамилия16\]\(#drevo-person-person-16\)/);
  assert.match(linked, /\[Фамилия15 Имя15\]\(#drevo-person-person-15\)/);
});

test("не подставляет ссылки в код, диаграммы, существующие ссылки и неоднозначные имена", () => {
  const references = [
    { kind: "person" as const, id: "a", label: "Петров Иван Андреевич" },
    { kind: "person" as const, id: "b", label: "Петров Иван Васильевич" },
  ];
  const source = [
    "Петров Иван, Петров Иван Андреевич, незнакомый Сидоров Пётр.",
    "[Петров Иван Андреевич](https://archive.example/person)",
    "`Петров Иван Андреевич`",
    "```mermaid\ngraph TD\n a[Петров Иван Андреевич]\n```",
  ].join("\n\n");
  const linked = linkResearchReferences(source, references);
  assert.match(
    linked,
    /^Петров Иван, \[Петров Иван Андреевич\]\(#drevo-person-a\), незнакомый Сидоров Пётр/,
  );
  assert.match(
    linked,
    /\[Петров Иван Андреевич\]\(https:\/\/archive\.example\/person\)/,
  );
  assert.match(linked, /`Петров Иван Андреевич`/);
  assert.match(linked, /a\[Петров Иван Андреевич\]/);
});

test("сохранённые маркеры остаются кликабельными без повторения ФИО", () => {
  const linked = linkResearchReferences(
    "Чепчугов Иван ([[person:a|Чепчугов Иван]]) и [[choose-person:b|Мария Вьюхина]]",
    [{ kind: "person", id: "a", label: "Чепчугов Иван" }],
  );
  assert.equal(
    linked,
    "[Чепчугов Иван](#drevo-person-a) и [Мария Вьюхина](#drevo-choose-person-b)",
  );
});
