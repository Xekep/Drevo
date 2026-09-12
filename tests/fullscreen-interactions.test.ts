import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ageLabel } from "../src/domain/dates.ts";
import type { Person } from "../src/domain/types.ts";

const root = new URL("..", import.meta.url);
const person = (birth: string, death: string): Person => ({
  id: "baby",
  surname: "Тестов",
  name: "Иван",
  patronymic: "",
  sex: "m",
  birth,
  death,
  deceased: true,
  birthPlace: "",
  deathPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  column: 0,
  generation: 1,
});

test("fullscreen uses the whole tree view so inspector and kinship UI stay visible", () => {
  const fullscreen = readFileSync(
    new URL("src/components/tree/use-tree-fullscreen.ts", root),
    "utf8",
  );
  const css = readFileSync(
    new URL("src/styles/mobile-refinements.css", root),
    "utf8",
  );

  assert.match(fullscreen, /closest<HTMLElement>\("\.tree-view"\)/);
  assert.match(fullscreen, /getHost\(\)\?\.requestFullscreen/);
  assert.match(
    css,
    /tree-view:has\(\.tree-canvas\.is-fullscreen\) > \.inspector-dock[\s\S]*display: block;[\s\S]*z-index: 1100/,
  );
});

test("mobile menu no longer contains the phone viewing notice", () => {
  const navigation = readFileSync(
    new URL("src/components/archive-navigation.tsx", root),
    "utf8",
  );
  assert.doesNotMatch(navigation, /Просмотр на телефоне/);
  assert.doesNotMatch(navigation, /Редактирование — с компьютера/);
});

test("opened person portrait is substantially larger on desktop and mobile", () => {
  const css = readFileSync(
    new URL("src/styles/mobile-refinements.css", root),
    "utf8",
  );
  assert.match(
    css,
    /\.profile-avatar\s*\{\s*width: 144px;\s*height: 144px;/,
  );
  assert.match(
    css,
    /@media \(max-width: 899px\)[\s\S]*\.profile-avatar\s*\{\s*width: 128px;\s*height: 128px;/,
  );
});

test("age under one year is shown in months", () => {
  assert.equal(ageLabel(person("2020-01-15", "2020-09-15")), "8 месяцев");
  assert.equal(ageLabel(person("2020-01-15", "2020-02-15")), "1 месяц");
  assert.equal(ageLabel(person("2020-01-15", "2020-02-14")), "меньше месяца");
  assert.equal(
    ageLabel(person("2020-01", "2020-09")),
    "около 8 месяцев",
  );
  assert.equal(ageLabel(person("2020", "2020")), "меньше года");
});

test("approximate age uses the genitive form after около", () => {
  assert.equal(ageLabel(person("1908-01-01", "1981-01-01")), "73 года");
  assert.equal(ageLabel(person("1908", "1981")), "около 73 лет");
  assert.equal(ageLabel(person("2000", "2021")), "около 21 года");
  assert.equal(ageLabel(person("2020-01", "2020-02")), "около 1 месяца");
  assert.equal(ageLabel(person("2020-01", "2020-03")), "около 2 месяцев");
});
