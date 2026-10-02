import assert from "node:assert/strict";
import test from "node:test";
import { treeRenderFamilyKey } from "../src/components/tree/tree-render-family.ts";
import type { Family, Person } from "../src/domain/types.ts";

function fixture(): Family {
  const person = (id: string): Person => ({
    id,
    surname: "Иванов",
    name: id,
    patronymic: "",
    sex: "u",
    birth: "1900",
    birthPlace: "Тверь",
    parents: [],
    spouses: [],
    generation: 0,
    column: 0,
    sources: [],
  });
  const parent = { ...person("parent"), spouses: ["partner"], createdBy: "owner-a" };
  const partner = { ...person("partner"), spouses: ["parent"] };
  const child = { ...person("child"), parents: ["parent", "partner"], generation: 1 };
  return {
    title: "Синтетический архив",
    description: "Проверка снимка отрисовки",
    demo: false,
    people: [parent, partner, child],
    unions: [{ id: "union", participants: ["parent", "partner"], type: "marriage" }],
    links: [{ id: "link", from: "partner", to: "child", type: "godparent", note: "Запись" }],
    photos: [],
  };
}

test("card detail hydration and gallery changes preserve the default render snapshot", () => {
  const family = fixture();
  const original = structuredClone(family);
  const hydrated = structuredClone(family);
  Object.assign(hydrated.people[0], {
    biography: "Подробная биография",
    occupation: "Учитель",
    occupationClaim: { value: "Учитель", sources: [], confidence: "confirmed" },
    maidenNameClaim: { value: "Петрова", sources: [], confidence: "probable" },
    sources: [{ title: "Архив", type: "record", reference: "Дело 1" }],
    awards: [{ id: "award", name: "Медаль" }],
    events: [{ id: "event", type: "education", date: "1920", place: "Москва" }],
  });
  hydrated.photos = [{ id: "gallery", url: "/photos/gallery.jpg", title: "Альбом", tags: [] }];

  assert.equal(treeRenderFamilyKey(hydrated), treeRenderFamilyKey(family));
  assert.deepEqual(family, original, "creating a render key must not remove actual card details");
  assert.deepEqual(hydrated.people[0].sources, [{ title: "Архив", type: "record", reference: "Дело 1" }]);
  assert.equal(hydrated.photos.length, 1);
});

test("visible person data, genealogy, ownership and relationship metadata invalidate the key", () => {
  const family = fixture();
  const key = treeRenderFamilyKey(family);
  const changes: [string, (next: Family) => void][] = [
    ["membership", (next) => { next.people.pop(); }],
    ["parents", (next) => { next.people[2].parents = ["parent"]; }],
    ["spouses", (next) => { next.people[0].spouses = []; }],
    ["parentage completeness", (next) => { next.people[2].parentageComplete = true; }],
    ["name", (next) => { next.people[0].name = "Анна"; }],
    ["surname", (next) => { next.people[0].surname = "Петров"; }],
    ["patronymic", (next) => { next.people[0].patronymic = "Иванович"; }],
    ["birth surname", (next) => { next.people[0].maidenName = "Петрова"; }],
    ["birth place", (next) => { next.people[0].birthPlace = "Москва"; }],
    ["death place", (next) => { next.people[0].deathPlace = "Рязань"; }],
    ["birth date", (next) => { next.people[0].birth = "1901"; }],
    ["death date", (next) => { next.people[0].death = "1980"; }],
    ["portrait", (next) => { next.people[0].photo = "/photos/portrait.jpg"; }],
    ["research marker", (next) => { next.people[0].needsReview = true; }],
    ["person owner", (next) => { next.people[0].createdBy = "owner-b"; }],
    ["link type", (next) => { next.links![0].type = "guardian"; }],
    ["link note", (next) => { next.links![0].note = "Уточнение"; }],
    ["link evidence", (next) => { next.links![0].sources = [{ title: "Связь", type: "record", reference: "2" }]; }],
    ["link owner", (next) => { next.links![0].createdBy = "owner-b"; }],
    ["union date", (next) => { next.unions![0].formation = { date: "1920" }; }],
    ["union owner", (next) => { next.unions![0].createdBy = "owner-b"; }],
  ];
  for (const [label, change] of changes) {
    const next = structuredClone(family);
    change(next);
    assert.notEqual(treeRenderFamilyKey(next), key, label);
  }
});

test("parsed render snapshots own their nested data without mutating the full archive", () => {
  const family = fixture();
  family.people[0].biography = "Биография";
  family.people[0].sources = [{ title: "Источник", type: "record", reference: "4" }];
  family.people[0].photo = "/photos/portrait.jpg";
  const overview: Family = JSON.parse(treeRenderFamilyKey(family));
  const before = structuredClone(family);

  assert.equal(overview.people[0].biography, undefined);
  assert.deepEqual(overview.people[0].sources, []);
  assert.equal(overview.people[0].photo, family.people[0].photo);
  assert.deepEqual(overview.photos, []);
  overview.people[2].parents.pop();
  overview.unions![0].participants[0] = "other";
  overview.links![0].note = "Изменённая заметка";
  assert.deepEqual(family, before);
  family.people[0].name = "Новое имя";
  assert.equal(overview.people[0].name, "parent");
});
