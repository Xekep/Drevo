import type { Person } from "../../src/domain/types.ts";

const person = (id: string, surname: string, name: string): Person => ({
  id,
  surname,
  name,
  patronymic: "Николаевич",
  sex: "m",
  birth: "1900",
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  column: 0,
  generation: 1,
});

export const searchPeople = [
  person("pavel", "Чепчугов", "Павел"),
  person("pavelina", "Чепчугов", "Павелина"),
  person("ivan", "Чепчугов", "Иван"),
  person("other-pavel", "Иванов", "Павел"),
  person("semyon", "Чепчугов", "Семён"),
];

// Newer weak matches deliberately precede older exact matches by upload date.
export const searchDocuments = [
  {
    id: "exact-person",
    title: "Метрическая запись",
    description: "",
    people: ["pavel"],
  },
  { id: "exact-title", title: "Чепчугов Павел", description: "", people: [] },
  {
    id: "title-words",
    title: "Павел — Чепчугов, запись",
    description: "",
    people: [],
  },
  {
    id: "partial-person",
    title: "Другая персона",
    description: "",
    people: ["pavelina"],
  },
  {
    id: "metadata",
    title: "Алфавитная книга",
    description: "Чепчугов, запись № 12. Павел",
    people: [],
  },
  {
    id: "surname-only",
    title: "Чепчугов Иван",
    description: "",
    people: ["ivan"],
  },
  {
    id: "split-people",
    title: "Общая запись",
    description: "",
    people: ["ivan", "other-pavel"],
  },
  { id: "yo-person", title: "Запись с ё", description: "", people: ["semyon"] },
  { id: "yo-title", title: "Чепчугов Семён", description: "", people: [] },
].map((document, index) => ({
  ...document,
  createdAt: `2026-01-${String(index + 1).padStart(2, "0")}`,
}));

export const rankedSearchIds = [
  "exact-title",
  "exact-person",
  "title-words",
  "partial-person",
  "metadata",
];
