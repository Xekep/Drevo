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
    [...text.matchAll(/^(1(?:\.\d+)*)\. (.+)\r?$/gm)].map((match) => [
      match[2].trim(),
      match[1],
    ]),
  );

test("d’Aboville follows female lines, numbers only descendants and retains both parents", () => {
  const source = family([
    person("Дед", { sex: "m", birth: "1928", spouses: ["Бабушка"] }),
    person("Бабушка", { sex: "f", birth: "1930" }),
    person("Мать", { sex: "f", birth: "1955", parents: ["Дед", "Бабушка"] }),
    person("Отец", { sex: "m", birth: "1954", spouses: ["Мать"] }),
    person("Сын", {
      birth: "1980",
      parents: ["Мать", "Отец"],
      spouses: ["Партнёр"],
    }),
    person("Партнёр", { birth: "1979" }),
    person("Внучка", { birth: "2005", parents: ["Сын", "Партнёр"] }),
    person("Посторонний", { birth: "1800" }),
  ]);
  const before = structuredClone(source);
  const ids = new Set(source.people.map((p) => p.id));
  const text = generationReport(source, ids, "Дед");
  assert.deepEqual(
    [...numbers(text)],
    [
      ["Дед", "1"],
      ["Мать", "1.1"],
      ["Сын", "1.1.1"],
      ["Внучка", "1.1.1.1"],
    ],
  );
  for (const level of ["I", "II", "III", "IV"])
    assert.ok(text.includes(`Поколение ${level}\r\n`));
  assert.match(text, /Отец: Отец/);
  assert.match(text, /Мать: №1\.1 Мать/);
  assert.match(text, /Дети: №1\.1\.1\.1 Внучка/);
  assert.match(text, /Партнёр \/ супруг\(а\): Бабушка/);
  assert.doesNotMatch(text, /Посторонний/);
  assert.equal(
    text,
    generationReport(family([...source.people].reverse()), ids, "Дед"),
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
  assert.deepEqual([...numbers(text)], [["Показан", "1"]]);
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
  assert.match(text, /\* 1900\r\n/);
  assert.match(text, /\+ дата неизвестна/);
  assert.doesNotMatch(text, /1900-01-01|1920-01-01|internal-document|жив/);
  assert.match(text, /Первая строка\r\n {6}Вторая строка/);
  assert.match(text, /× до 1918 года; Иван/);
  assert.match(text, /Развод: 1921/);
  assert.match(text, /Партнёрство: Пётр/);
  assert.match(text, /Переезд: около 1920 года; Казань/);
  assert.match(text, /Военная служба: дата неизвестна/);
  assert.match(text, /Ф\. 1\. Оп\. 2\. Д\. 3\. Л\. 4\./);
  assert.match(text, /Источник рождения:/);
  assert.match(text, /Оценка рождения: Вероятно/);
  assert.equal(numbers(text).size, 1);
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
  assert.match(text, /\* 05\.1980\r\n/);
  assert.match(text, /\+ 10\.05\.2020\r\n/);
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
    "Ребёнок",
  );
  assert.doesNotMatch(text, /Поколение II/);
  assert.match(text, /Усыновитель: Родитель/);
  assert.match(text, /Предполагаемый родитель: Возможный; Не подтверждено/);
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
  const text = generationReport(family(people), ids, "Человек 0");
  assert.equal(numbers(text).size, 1000);
  assert.equal(new Set(numbers(text).values()).size, 1000);
  assert.match(text, /см. основную запись/);
  assert.equal(numbers(text).get("Человек 1"), "1.1");
  assert.equal(numbers(text).get("Человек 3"), "1.1.1");
  assert.equal(
    text,
    generationReport(family([...people].reverse()), ids, "Человек 0"),
  );
  assert.match(text, /Поколение X/);
});

test("siblings sort by recorded date then deterministic name/ID; unknown names stay readable", () => {
  const data = family([
    person("root"),
    person("late", { name: "Поздний", birth: "1901-02", parents: ["root"] }),
    person("early", { name: "Ранний", birth: "1900", parents: ["root"] }),
    person("unknown-b", { name: "", parents: ["root"] }),
    person("unknown-a", { name: "", parents: ["root"] }),
  ]);
  const ids = new Set(data.people.map((p) => p.id));
  const text = generationReport(data, ids, "root");
  assert.match(text, /^1\.1\. Ранний\r?$/m);
  assert.match(text, /^1\.2\. Поздний\r?$/m);
  assert.match(text, /^1\.3\. Имя неизвестно\r?$/m);
  assert.equal(
    text,
    generationReport(family([...data.people].reverse()), ids, "root"),
  );
  assert.throws(() => generationReport(data, ids, "missing"), /родоначальника/);
});

test("shared descendants use one shortest-path record and never number an unrelated spouse", () => {
  const data = family([
    person("root"),
    person("a", { parents: ["root"], birth: "1900" }),
    person("b", { parents: ["root"], birth: "1901", spouses: ["a"] }),
    person("shared", { parents: ["a", "b"] }),
    person("external", { spouses: ["shared"], biography: "Внешний супруг" }),
    person("last", { parents: ["shared", "external"] }),
  ]);
  const text = generationReport(
    data,
    new Set(data.people.map((p) => p.id)),
    "root",
  );
  assert.equal(numbers(text).get("shared"), "1.1.1");
  assert.equal(numbers(text).get("last"), "1.1.1.1");
  assert.match(text, /№1\.1\.1 shared \(ветвь 1\.2\.1; см. основную запись\)/);
  assert.equal(text.match(/^1(?:\.\d+)*\. shared\r?$/gm)?.length, 1);
  assert.equal(numbers(text).has("external"), false);
  assert.match(text, /Внешний супруг/);
  // The same person reached at a different depth keeps the shortest path.
  data.people.find((p) => p.id === "shared")!.parents.push("root");
  const shortened = generationReport(
    data,
    new Set(data.people.map((p) => p.id)),
    "root",
  );
  assert.equal(numbers(shortened).get("shared"), "1.3");
});

test("cyclic parentage terminates and links back to one primary record", () => {
  const data = family([
    person("a", { parents: ["c"] }),
    person("b", { parents: ["a"] }),
    person("c", { parents: ["b", "c"] }),
  ]);
  const text = generationReport(data, new Set(["a", "b", "c"]), "a");
  assert.equal(numbers(text).size, 3);
  assert.match(text, /№1 a \(ветвь 1\.1\.1\.1; см. основную запись\)/);
  assert.ok(text.length < 5000);
});

test("life and event symbols preserve Julian calendar, unknown dates and qualified text", () => {
  const data = family([
    person("a", {
      birth: "1908-11-19",
      birthJulian: "1908-11-06",
      death: "1980-05",
      deathPlace: "Свердловск",
      events: [
        {
          id: "christen",
          type: "baptism",
          date: "1908-11-20",
          place: "Чепчугова",
        },
        {
          id: "burial",
          type: "burial",
          dateText: "после 1980 года",
          place: "Кладбище",
        },
      ],
      factAlternatives: [
        {
          id: "other-birth",
          field: "birth",
          value: "1907",
          sources: [],
          confidence: "tentative",
        },
      ],
    }),
  ]);
  const text = generationReport(data, new Set(["a"]), "a");
  assert.match(text, /\* 06\.11\.1908 \(ст. ст.\) \/ 19\.11\.1908 \(н. ст.\)/);
  assert.match(text, /\+ 05\.1980, Свердловск/);
  assert.match(text, /~ 20\.11\.1908; Чепчугова/);
  assert.match(text, /□ после 1980 года; Кладбище/);
  assert.match(text, /Другой вариант рождения: 1907/);
  data.people[0].birth = "1908-11";
  data.people[0].birthJulian = "1908-11";
  assert.match(
    generationReport(data, new Set(["a"]), "a"),
    /\* 11\.1908 \(ст. ст.\)\r\n/,
  );
});

test("multiple marriages preserve partners’ facts and do not assign a single-parent child to a spouse", () => {
  const data = family(
    [
      person("root", { sex: "m" }),
      person("first", {
        sex: "f",
        birth: "1890",
        biography: "Первая жена",
        sources: [{ title: "Запись жены", type: "архив", reference: "л. 2" }],
      }),
      person("second", {
        sex: "f",
        birth: "1895",
        events: [{ id: "b", type: "burial", date: "1970" }],
      }),
      person("known", { parents: ["root", "first"], birth: "1910" }),
      person("one-parent", { parents: ["root"], birth: "1915" }),
    ],
    {
      unions: [
        {
          id: "u1",
          participants: ["root", "first"],
          type: "marriage",
          formation: { date: "1909", place: "Казань" },
        },
        {
          id: "u2",
          participants: ["root", "second"],
          type: "marriage",
          formation: { dateText: "ок. 1914" },
        },
      ],
    },
  );
  const text = generationReport(
    data,
    new Set(data.people.map((p) => p.id)),
    "root",
  );
  assert.match(text, /Жена: first/);
  assert.match(text, /× 1909, Казань; first/);
  assert.match(text, /× ок. 1914; second/);
  assert.match(text, /Запись жены/);
  assert.match(text, /□ 1970/);
  const child = text.slice(text.indexOf("1.2. one-parent"));
  assert.match(child, /Отец: №1 root/);
  assert.doesNotMatch(child, /first|second|Мать:/);
  assert.equal(numbers(text).size, 3);
});

test("traditional numbering uses person.parent headings, continuous references and female-line parents", () => {
  const data = family([
    person("root"), person("daughter", { sex: "f", birth: "1900", parents: ["root"] }),
    person("son", { sex: "m", birth: "1901", parents: ["root"] }),
    person("external-father", { sex: "m", spouses: ["daughter"] }),
    person("grandchild", { birth: "1920", parents: ["daughter", "external-father"] }),
    person("shared", { birth: "1921", parents: ["daughter", "son"] }),
  ]);
  const ids = new Set(data.people.map(p => p.id));
  const before = structuredClone(data);
  const text = generationReport(data, ids, "root", "person-parent");
  assert.match(text, /^1\. root\r?$/m);
  assert.match(text, /^2\.1\. daughter\r?$/m);
  assert.match(text, /^3\.1\. son\r?$/m);
  assert.match(text, /^4\.2\. grandchild\r?$/m);
  assert.match(text, /^5\.3\. shared\r?$/m);
  assert.match(text, /Дети: №4 grandchild; №5 shared/);
  assert.match(text, /№5 shared \(повторная ссылка; см. основную запись\)/);
  assert.equal(text.match(/^5\.3\. shared\r?$/gm)?.length, 1);
  assert.doesNotMatch(text, /ветвь 1\.|Нумерация д’Абовилля|^\d+\.\d+\. external-father/m);
  assert.equal(text, generationReport(family([...data.people].reverse()), ids, "root", "person-parent"));
  assert.deepEqual(data, before);
  assert.throws(() => generationReport(data, ids, "root", "invalid" as never), /Неизвестная система/);
});

test("traditional numbering keeps only permitted references and terminates cyclic data", () => {
  const data = family([person("a", { parents: ["c", "hidden"] }), person("b", { parents: ["a"] }), person("c", { parents: ["b"] }), person("hidden")]);
  const text = generationReport(data, new Set(["a", "b", "c"]), "a", "person-parent");
  assert.match(text, /^2\.1\. b\r?$/m);
  assert.match(text, /^3\.2\. c\r?$/m);
  assert.match(text, /№1 a \(повторная ссылка; см. основную запись\)/);
  assert.doesNotMatch(text, /hidden|№undefined/);
  assert.equal([...text.matchAll(/^\d+(?:\.\d+)?\. [abc]\r?$/gm)].length, 3);
});
