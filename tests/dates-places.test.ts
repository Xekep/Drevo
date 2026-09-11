import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeDateInput,
  dateInputLabel,
  dateBound,
  dateLabel,
  validDate,
} from "../src/domain/dates.ts";
import {
  familyPlaces,
  photonResult,
  historicalMatches,
  historicalCandidates,
  placeSearch,
} from "../src/domain/places.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { geocodingStore } from "../src/server/geocoding.ts";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import type { Person, Family } from "../src/domain/types.ts";
const person: Person = {
  id: "a",
  surname: "Тестова",
  name: "Анна",
  patronymic: "",
  sex: "f",
  birth: "1980",
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  column: 0,
  generation: 1,
};
const family = (p: Person): Family => ({
  title: "Проверка",
  description: "",
  demo: false,
  people: [p],
});
test("local date formats preserve precision and reject impossible dates", () => {
  for (const [input, iso] of [
    ["1.5.1980", "1980-05-01"],
    ["01.05.1980", "1980-05-01"],
    ["1/5/1980", "1980-05-01"],
    ["1980-5-1", "1980-05-01"],
    ["05.1980", "1980-05"],
    ["1980-05", "1980-05"],
    [" 1980 ", "1980"],
    ["", ""],
    ["29.2.2000", "2000-02-29"],
  ])
    assert.equal(normalizeDateInput(input), iso);
  for (const invalid of [
    "31.4.1980",
    "29.2.1900",
    "1980-13",
    "1980-00",
    "1.1.80",
    "31.12.0000",
    "1980-02-30",
    "31.31.1980",
  ])
    assert.throws(() => normalizeDateInput(invalid));
  assert.equal(dateInputLabel("1980-05"), "05.1980");
  assert.equal(dateInputLabel("1980-05-01"), "01.05.1980");
  assert.equal(dateBound("2000-02", true), "2000-02-29");
  assert.equal(dateBound("1900-02", true), "1900-02-28");
  assert.equal(dateBound("1980", false), "1980-01-01");
  assert.match(dateLabel("1980-05"), /май 1980/);
  assert.equal(validDate("0000-01-01"), false);
  assert.doesNotThrow(() =>
    validateFamily(
      family({ ...person, birth: "1980-05-20", death: "1980-05" }),
    ),
  );
  assert.throws(() =>
    validateFamily(
      family({ ...person, birth: "1980-05", death: "1980-04-30" }),
    ),
  );
});
test("places derive only from recorded events and stale coordinates do not follow a renamed place", () => {
  const p = {
    ...person,
    birthPlace: " Старый город ",
    deathPlace: "Старый город",
    birthLocation: {
      place: "Старый город",
      lat: 55,
      lon: 60,
      label: "Нынешнее имя",
    },
  };
  const before = structuredClone(p),
    places = familyPlaces([p]);
  assert.equal(places.length, 1);
  assert.equal(places[0].events.length, 2);
  assert.equal(places[0].location?.label, "Нынешнее имя");
  assert.equal(
    familyPlaces([{ ...p, birthPlace: "Другая область", deathPlace: "" }])[0]
      .location,
    undefined,
  );
  assert.equal(familyPlaces([{ ...person }]).length, 0);
  assert.deepEqual(p, before);
  assert.equal(placeSearch("Свердловск-44"), "Свердловск-44");
  assert.throws(() =>
    validateFamily(
      family({ ...p, birthLocation: { ...p.birthLocation, lat: 91 } }),
    ),
  );
});
const feature = (name: string, lon = 60, lat = 55) => ({
  properties: { name, osm_key: "place", state: "Тестовая область" },
  geometry: { coordinates: [lon, lat] },
});
test("automatic geocoding requires an exact unambiguous match", () => {
  assert.equal(
    photonResult("Старый город", { features: [feature("Другой город")] })
      .automatic,
    undefined,
  );
  assert.equal(
    photonResult("Город", {
      features: [feature("Город"), feature("Город", 40)],
    }).automatic,
    undefined,
  );
  assert.equal(
    photonResult("Город, Тестовая область", { features: [feature("Город")] })
      .automatic?.lat,
    55,
  );
  assert.equal(
    photonResult("Город", { features: [feature("Город", 400)] }).candidates
      .length,
    0,
  );
});
const search = {
  search: [
    {
      id: "Q123",
      label: "Современное имя",
      description: "город",
      match: { text: "Старое имя" },
    },
  ],
};
const entities = {
  entities: {
    Q123: {
      claims: {
        P17: [{ mainsnak: { datavalue: { value: { id: "Q159" } } } }],
        P625: [
          {
            rank: "normal",
            mainsnak: {
              datavalue: {
                value: {
                  latitude: 55,
                  longitude: 60,
                  globe: "http://www.wikidata.org/entity/Q2",
                },
              },
            },
          },
        ],
      },
    },
  },
};
test("historical names use external aliases and Earth coordinates without city-specific substitutions", async () => {
  const matches = historicalMatches("Старое имя", search);
  assert.equal(matches.length, 1);
  assert.equal(historicalMatches("Неизвестное имя", search).length, 0);
  assert.equal(
    historicalCandidates(matches, entities)[0].name,
    "Современное имя",
  );
  const alien = structuredClone(entities);
  alien.entities.Q123.claims.P625[0].mainsnak.datavalue.value.globe =
    "http://www.wikidata.org/entity/Q111";
  assert.equal(historicalCandidates(matches, alien).length, 0);
  const db = new DatabaseSync(":memory:"),
    calls: URL[] = [];
  initializeArchiveSchema(db);
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    return new Response(
      JSON.stringify(
        url.hostname === "photon.komoot.io"
          ? { features: [] }
          : url.searchParams.get("action") === "wbsearchentities"
            ? search
            : entities,
      ),
    );
  };
  const store = geocodingStore(db, fetcher, 0);
  try {
    const [a, b] = await Promise.all([
      store.locate("Старое имя"),
      store.locate("Старое имя"),
    ]);
    assert.equal(a.automatic?.name, "Современное имя");
    assert.deepEqual(a, b);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].searchParams.get("q"), "Старое имя");
    await store.locate("Старое имя");
    assert.equal(calls.length, 3);
    store.close();
    const reopened = geocodingStore(db, fetcher, 0);
    await reopened.locate("Старое имя");
    assert.equal(calls.length, 3);
    reopened.close();
  } finally {
    store.close();
    db.close();
  }
});
