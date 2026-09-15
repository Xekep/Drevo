import assert from "node:assert/strict";
import test from "node:test";
import {
  AWARD_CATALOG,
  getAwardDefinition,
  normalizeAwardName,
  resolveAwardName,
  searchAwards,
} from "../src/features/awards/catalog/index.ts";

test("каталог содержит военные, трудовые, юбилейные и иностранные награды", () => {
  assert.ok(AWARD_CATALOG.length >= 50);
  assert.equal(getAwardDefinition("ussr-medal-veteran-labour")?.level, "state");
  assert.equal(
    getAwardDefinition("ru-rosatom-veteran-nuclear-energy-industry")?.level,
    "departmental",
  );
  assert.equal(
    getAwardDefinition("mn-jubilee-30-khalkhin-gol-victory")?.country,
    "MN",
  );
});

test("поиск наград работает по названию, стране и тегам", () => {
  assert.ok(
    searchAwards("оборона ВОВ").some(
      (award) => award.id === "ussr-medal-defense-moscow",
    ),
  );
  assert.ok(
    searchAwards("атомная ветеран").some(
      (award) => award.id === "ru-rosatom-veteran-nuclear-energy-industry",
    ),
  );
  assert.ok(
    searchAwards("Монголия Халхин 30").some(
      (award) => award.id === "mn-jubilee-30-khalkhin-gol-victory",
    ),
  );
});

test("нормализация переживает кавычки, ё, тире и форму 30-летия", () => {
  assert.equal(normalizeAwardName("  МЕДАЛЬ «За Отвагу» "), "медаль за отвагу");
  assert.equal(
    resolveAwardName("Медаль 30-летия Халхин-Гольской Победы")?.award.id,
    "mn-jubilee-30-khalkhin-gol-victory",
  );
  assert.equal(
    resolveAwardName("30 лет Халхин Гольской Победы")?.award.id,
    "mn-jubilee-30-khalkhin-gol-victory",
  );
});

test("ручной ввод извлекает степень и не ломает старые короткие названия", () => {
  assert.deepEqual(resolveAwardName("Орден Славы III степени"), {
    award: getAwardDefinition("ussr-order-glory"),
    degreeId: "3",
  });
  assert.equal(
    resolveAwardName("ветеран атомной промышленности")?.award.id,
    "ru-rosatom-veteran-nuclear-energy-industry",
  );
  assert.equal(resolveAwardName("За отвагу")?.award.id, "ussr-medal-for-courage");
});

test("проверенные изображения привязаны к определениям, а не к человеку", () => {
  assert.equal(getAwardDefinition("ussr-order-red-star")?.imageStatus, "verified");
  assert.match(
    getAwardDefinition("ussr-order-red-star")?.image?.src || "",
    /commons\.wikimedia\.org/,
  );
  assert.equal(
    getAwardDefinition("mn-jubilee-30-khalkhin-gol-victory")?.imageStatus,
    "verified",
  );
});

test("награды из существующего семейного профиля имеют реальные изображения", () => {
  const cases = [
    ["Медаль «За отвагу»", "1943"],
    ["Орден Славы III степени", "1945"],
    ["Медаль «За победу над Германией в Великой Отечественной войне 1941–1945 гг.»", "1945"],
    ["Медаль «За взятие Кенигсберга»", "1945"],
    ["Медаль «За взятие Берлина»", "1945"],
  ] as const;

  for (const [name, year] of cases) {
    const resolved = resolveAwardName(name, year);
    assert.ok(resolved, name);
    const degreeImage = resolved.award.degrees?.find(
      (degree) => degree.id === resolved.degreeId,
    )?.image;
    assert.equal(resolved.award.imageStatus, "verified", name);
    assert.ok(degreeImage || resolved.award.image, `${name}: нет изображения`);
    assert.match(
      (degreeImage || resolved.award.image)?.src || "",
      /^https:\/\/upload\.wikimedia\.org\//,
      name,
    );
  }
});
