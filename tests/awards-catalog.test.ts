import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  activeInYear,
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

test("система наград зашита в стабильный id и не выводится из совпавшего названия", () => {
  const prefixes: Record<string, string> = {
    USSR: "ussr-",
    RU: "ru-",
    MN: "mn-",
    PL: "pl-",
    CS: "cs-",
    DDR: "ddr-",
  };

  for (const award of AWARD_CATALOG) {
    const prefix = prefixes[award.country];
    if (prefix) assert.ok(award.id.startsWith(prefix), `${award.id}: неверная система ${award.country}`);
  }
});

test("год ограничивает страну и эпоху наградной системы", () => {
  const soviet = getAwardDefinition("ussr-medal-veteran-labour");
  const russian = getAwardDefinition("ru-medal-zhukov");
  const ddr = getAwardDefinition("ddr-medal-brotherhood-arms");
  assert.ok(soviet && russian && ddr);

  assert.equal(activeInYear(soviet, "1985"), true);
  assert.equal(activeInYear(soviet, "2005"), false);
  assert.equal(activeInYear(russian, "1985"), false);
  assert.equal(activeInYear(russian, "2005"), true);
  assert.equal(activeInYear(ddr, "1985"), true);
  assert.equal(activeInYear(ddr, "2005"), false);

  assert.equal(resolveAwardName("Ветеран труда", "1985")?.award.country, "USSR");
  assert.equal(resolveAwardName("Ветеран труда", "2005"), undefined);
  assert.equal(resolveAwardName("Медаль Жукова", "1985"), undefined);
  assert.equal(resolveAwardName("Медаль Жукова", "2005")?.award.country, "RU");
});

test("несовместимый год не удерживает ранее выбранную страну", () => {
  assert.equal(
    resolveAwardName("Ветеран труда", "2005", "ussr-medal-veteran-labour"),
    undefined,
  );
  assert.equal(
    resolveAwardName("Ветеран труда", "1985", "ussr-medal-veteran-labour")?.award.id,
    "ussr-medal-veteran-labour",
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
  assert.equal(
    getAwardDefinition("mn-jubilee-30-khalkhin-gol-victory")?.imageStatus,
    "verified",
  );
});

test("награды из существующего семейного профиля используют реальные локальные PNG СССР", () => {
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
    const image = degreeImage || resolved.award.image;
    assert.equal(resolved.award.imageStatus, "verified", name);
    assert.ok(image, `${name}: нет изображения`);
    assert.match(image.src, /^\/awards\/ussr\/.*\.png$/, name);
    assert.ok(existsSync(join(process.cwd(), "public", image.src.slice(1))), `${name}: PNG не подготовлен`);
  }
});

test("локальные растровые изображения разделены по системам наград", () => {
  assert.match(
    getAwardDefinition("ussr-medal-veteran-labour")?.image?.src || "",
    /^\/awards\/ussr\/.*\.png$/,
  );
  assert.match(
    getAwardDefinition("mn-jubilee-30-khalkhin-gol-victory")?.image?.src || "",
    /^\/awards\/mn\/.*\.png$/,
  );

  const rosatom = getAwardDefinition("ru-rosatom-veteran-nuclear-energy-industry");
  assert.match(
    rosatom?.image?.src || "",
    /^\/awards\/ru\/rosatom\/.*\.png$/,
  );
  assert.equal(rosatom?.imageStatus, "pending-license-review");

  const localImages = AWARD_CATALOG.flatMap((award) => [
    award.image?.src,
    ...(award.degrees?.map((degree) => degree.image?.src) || []),
  ]).filter((src): src is string => !!src && src.startsWith("/awards/"));

  assert.equal(new Set(localImages).size, localImages.length, "один локальный ассет привязан к нескольким определениям/степеням");
  for (const src of localImages) {
    assert.ok(!src.endsWith(".svg"), `${src}: самодельные SVG наград запрещены`);
    assert.ok(existsSync(join(process.cwd(), "public", src.slice(1))), `${src}: локальный файл отсутствует`);
  }
});

test("точный awardDefinitionId сохраняет выбранную систему наград при совместимом годе", () => {
  const selected = resolveAwardName(
    "Ветеран атомной промышленности",
    "2020",
    "ru-rosatom-veteran-nuclear-energy-industry",
  );
  assert.equal(selected?.award.country, "RU");
  assert.equal(selected?.award.id, "ru-rosatom-veteran-nuclear-energy-industry");
});
