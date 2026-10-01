import assert from "node:assert/strict";
import test from "node:test";
import { generationReport } from "../src/domain/generation-report.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  name: id,
  surname: "",
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  parents: [],
  spouses: [],
  generation: 99,
  column: 0,
  sources: [],
  ...extra,
});
const family = (people: Person[], extra: Partial<Family> = {}): Family => ({
  title: "Семейный архив",
  description: "",
  demo: false,
  people,
  ...extra,
});
const numbers = (text: string) =>
  new Map(
    [...text.matchAll(/^(\d+)(?: \([\d, ]+\))?\. (.+)\r?$/gm)].map((match) => [
      match[2].trim(),
      Number(match[1]),
    ]),
  );

test("traditional register has continuous numbers, Roman generations and both parental references", () => {
  const people = [
    person("Дед", { sex: "m", birth: "1928", spouses: ["Бабушка"] }),
    person("Бабушка", { sex: "f", birth: "1930" }),
    person("Мать", { sex: "f", birth: "1955", parents: ["Дед", "Бабушка"] }),
    person("Отец", { sex: "m", birth: "1954" }),
    person("Сын", {
      birth: "1980",
      parents: ["Мать", "Отец"],
      spouses: ["Партнёр"],
    }),
    person("Партнёр", { birth: "1979" }),
    person("Внучка", { birth: "2005", parents: ["Сын", "Партнёр"] }),
  ];
  const source = family(people);
  const before = structuredClone(source);
  const text = generationReport(source, new Set(people.map((p) => p.id)));
  const ids = numbers(text);
  assert.deepEqual([...ids.values()], [1, 2, 3, 4, 5, 6, 7]);
  for (const level of ["I", "II", "III", "IV"])
    assert.match(text, new RegExp(`Поколение ${level}\\r\\n`));
  assert.match(
    text,
    new RegExp(
      `${ids.get("Сын")} \\(${[ids.get("Мать"), ids.get("Отец")].sort((a, b) => a! - b!).join(", ")}\\)\\. Сын`,
    ),
  );
  assert.ok(text.includes(`Отец: №${ids.get("Отец")} Отец`));
  assert.ok(text.includes(`Мать: №${ids.get("Мать")} Мать`));
  assert.ok(text.includes(`Дети: №${ids.get("Внучка")} Внучка`));
  assert.equal(
    text,
    generationReport(
      family([...people].reverse()),
      new Set([...people].reverse().map((p) => p.id)),
    ),
  );
  assert.deepEqual(source, before);
});

test("visible projection cannot leak relatives through parents, unions, links or numbering", () => {
  const source = family(
    [
      person("Показан", { parents: ["СЕКРЕТ"], spouses: ["СЕКРЕТ"] }),
      person("СЕКРЕТ", { biography: "Закрытая биография" }),
    ],
    {
      unions: [
        {
          id: "private",
          participants: ["Показан", "СЕКРЕТ"],
          type: "marriage",
          note: "Секретный брак",
        },
      ],
      links: [
        {
          id: "private-link",
          from: "СЕКРЕТ",
          to: "Показан",
          type: "presumed_parent",
          note: "Закрытая гипотеза",
        },
      ],
    },
  );
  const text = generationReport(source, new Set(["Показан", "missing"]));
  assert.doesNotMatch(
    text,
    /СЕКРЕТ|Закрыт|Секретный|Супруг\(а\):|Родитель:|\(2\)/,
  );
  assert.match(text, /Людей: 1\. Поколений: 1\./);
  assert.deepEqual([...numbers(text)], [["Показан", 1]]);
  assert.throws(
    () => generationReport(source, new Set(["missing"])),
    /нет людей/,
  );
});

test("register retains review markers, qualified dates, union history, biography and evidence", () => {
  const citation = {
    title: "Метрическая книга",
    type: "архив",
    reference: "Ф. 1. Оп. 2. Д. 3. Л. 4.",
    url: "https://example.test/record",
    documentId: "internal-document",
  };
  const source = family(
    [
      person("Анна", {
        sex: "f",
        birth: "1900",
        maidenName: "Иванова",
        needsReview: true,
        deceased: true,
        occupation: "Учитель",
        biography: "Первая строка\nВторая строка",
        sources: [citation],
        birthDateClaim: {
          value: "1900",
          sources: [citation],
          confidence: "probable",
        },
        events: [
          {
            id: "move",
            type: "move",
            date: "1920",
            dateText: "около 1920 года",
            place: "Казань",
            sources: [citation],
          },
          { id: "war", type: "military" },
        ],
      }),
      person("Иван"),
      person("Пётр"),
    ],
    {
      unions: [
        {
          id: "first",
          participants: ["Анна", "Иван"],
          type: "marriage",
          formation: {
            date: "1918",
            dateText: "до 1918 года",
            sources: [citation],
          },
          divorce: { date: "1921" },
        },
        {
          id: "second",
          participants: ["Анна", "Пётр"],
          type: "partnership",
          note: "Сведения из письма",
        },
      ],
    },
  );
  const text = generationReport(
    source,
    new Set(source.people.map((p) => p.id)),
  );
  assert.match(text, /Данные требуют проверки/);
  assert.match(text, /Род\.: 1900\r\n/);
  assert.match(text, /Ум\.: дата неизвестна/);
  assert.doesNotMatch(text, /1900-01-01|1920-01-01|internal-document|жив/);
  assert.match(text, /Первая строка\r\n {6}Вторая строка/);
  assert.match(text, /Заключение союза: до 1918 года/);
  assert.match(text, /Развод: 1921/);
  assert.match(text, /Партнёрство: №\d+ Пётр/);
  assert.match(text, /Переезд: около 1920 года; Казань/);
  assert.match(text, /Военная служба: дата неизвестна/);
  assert.match(text, /Ф\. 1\. Оп\. 2\. Д\. 3\. Л\. 4\./);
  assert.match(text, /Источник рождения:/);
  assert.match(text, /Оценка рождения: Вероятно/);
  assert.equal(numbers(text).size, 3);
});

test("Russian date notation preserves year, month and day precision", () => {
  const source = family([
    person("Человек", {
      birth: "1980-05",
      death: "2020-05-10",
      events: [
        { id: "school", type: "education", date: "1990", endDate: "1995-06" },
      ],
    }),
  ]);
  const text = generationReport(source, new Set(["Человек"]));
  assert.match(text, /Род\.: 05\.1980\r\n/);
  assert.match(text, /Ум\.: 10\.05\.2020\r\n/);
  assert.match(text, /Учёба: 1990; до 06\.1995/);
  assert.doesNotMatch(text, /01\.05\.1980|01\.01\.1990/);
});

test("adoption and hypotheses stay explicitly separate from biological parentage", () => {
  const source = family(
    [person("Родитель"), person("Ребёнок"), person("Возможный")],
    {
      links: [
        {
          id: "adoption",
          from: "Родитель",
          to: "Ребёнок",
          type: "adoptive_parent",
        },
        {
          id: "hypothesis",
          from: "Возможный",
          to: "Ребёнок",
          type: "presumed_parent",
          note: "Не подтверждено",
        },
      ],
    },
  );
  const text = generationReport(
    source,
    new Set(source.people.map((p) => p.id)),
  );
  assert.match(text, /Поколение II/);
  assert.match(text, /Усыновитель: №\d+ Родитель/);
  assert.match(
    text,
    /Предполагаемый родитель: №\d+ Возможный; Не подтверждено/,
  );
  assert.doesNotMatch(text, /(?:Отец|Мать|Родитель): №/);
  assert.match(text, /^\d+\. Ребёнок\r?$/m);
});

test("a thousand people and pedigree collapse are numbered once without recursive traversal", () => {
  const people = Array.from({ length: 1000 }, (_, index) =>
    person(`Человек ${index}`, {
      birth: String(1800 + Math.floor(Math.log2(index + 1)) * 20),
      parents: index ? [`Человек ${Math.floor((index - 1) / 2)}`] : [],
    }),
  );
  people[999].parents.push("Человек 498");
  const ids = new Set(people.map((p) => p.id));
  const text = generationReport(family(people), ids);
  assert.equal(numbers(text).size, 1000);
  assert.deepEqual(
    [...numbers(text).values()],
    Array.from({ length: 1000 }, (_, i) => i + 1),
  );
  assert.equal(text, generationReport(family([...people].reverse()), ids));
  assert.match(text, /Поколение X/);
});
