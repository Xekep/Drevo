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
  historicalSearchTerm,
  mergeNearbyPlaceCandidates,
  placeCandidateMatchesQuery,
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
const feature = (name: string, lon = 60, lat = 55, county = "") => ({
  properties: {
    name,
    osm_key: "place",
    state: "Тестовая область",
    ...(county ? { county } : {}),
  },
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
test("place candidates show municipalities and coordinates only for remaining duplicate labels", () => {
  const municipalities = photonResult("Мурзинка, Тестовая область", {
    features: [
      feature("Мурзинка", 61.025337, 57.688824, "Первый округ"),
      feature("Мурзинка", 60.096289, 57.17419, "Второй округ"),
      feature("Мурзинка", 60.404949, 57.033039, "Третий округ"),
    ],
  });
  assert.deepEqual(
    municipalities.candidates.map((candidate) => candidate.label),
    [
      "Мурзинка, Первый округ, Тестовая область",
      "Мурзинка, Второй округ, Тестовая область",
      "Мурзинка, Третий округ, Тестовая область",
    ],
  );

  const duplicates = photonResult("Мурзинка, Тестовая область", {
    features: [
      feature("Мурзинка", 61.025337, 57.688824),
      feature("Мурзинка", 60.096289, 57.17419),
    ],
  });
  assert.equal(
    new Set(duplicates.candidates.map((candidate) => candidate.label)).size,
    2,
  );
  assert.match(
    duplicates.candidates[0].label,
    /координаты 57\.68882, 61\.02534/,
  );
});
test("candidate context tolerates inflection and nearby providers do not duplicate a place", () => {
  const current = {
      lat: 57.688824,
      lon: 61.025337,
      name: "Мурзинка",
      label:
        "Мурзинка, Горноуральский муниципальный округ, Свердловская область, Россия",
    },
    wikidata = {
      lat: 57.690277777778,
      lon: 61.016944444444,
      name: "Мурзинка",
      label:
        "Мурзинка — село в Горноуральском городском округе Свердловской области России",
    },
    another = {
      lat: 57.17551,
      lon: 60.09333,
      name: "Мурзинка",
      label: "Мурзинка — посёлок в Свердловской области",
    };
  assert.equal(
    placeCandidateMatchesQuery("Мурзинка, Свердловская область", wikidata),
    true,
  );
  assert.deepEqual(mergeNearbyPlaceCandidates([current], [wikidata, another]), [
    current,
    another,
  ]);
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

test("qualified historical lookup searches the name and matches inflected region descriptions", () => {
  assert.equal(historicalSearchTerm("Нижнее, Луганская область"), "Нижнее");
  const result = historicalMatches("Нижнее, Луганская область", {
    search: [
      {
        id: "Q4318774",
        label: "Нижнее",
        description: "деревня в Вологодском районе Вологодской области России",
      },
      {
        id: "Q4318776",
        label: "Нижнее",
        description: "посёлок в Северскодонецком районе Луганской области",
      },
      {
        id: "Q4318779",
        label: "Нижнее",
        description: "село во Львовской области",
      },
    ],
  });
  assert.deepEqual(
    result.map((match) => match.id),
    ["Q4318776"],
  );
  assert.equal(result[0].contextMatched, true);

  const unknownRegion = historicalMatches("Нижнее, Несуществующая область", {
    search: [
      {
        id: "Q4318776",
        label: "Нижнее",
        description: "посёлок в Северскодонецком районе Луганской области",
      },
    ],
  });
  assert.equal(unknownRegion[0].contextMatched, false);
});

test("qualified historical geocoding locates a settlement absent from Photon", async () => {
  const db = new DatabaseSync(":memory:"),
    calls: URL[] = [];
  initializeArchiveSchema(db);
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === "photon.komoot.io")
      return Response.json({ features: [] });
    if (url.searchParams.get("action") === "wbsearchentities")
      return Response.json({
        search: [
          {
            id: "Q4318776",
            label: "Нижнее",
            description: "посёлок в Северскодонецком районе Луганской области",
          },
        ],
      });
    return Response.json({
      entities: {
        Q4318776: {
          claims: {
            P17: [{ mainsnak: { datavalue: { value: { id: "Q212" } } } }],
            P625: [
              {
                rank: "normal",
                mainsnak: {
                  datavalue: {
                    value: {
                      latitude: 48.771388888889,
                      longitude: 38.62,
                      globe: "http://www.wikidata.org/entity/Q2",
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });
  };
  const store = geocodingStore(db, fetcher, 0);
  try {
    const result = await store.locate("Нижнее, Луганская область");
    assert.equal(result.automatic?.name, "Нижнее");
    assert.equal(result.automatic?.lat, 48.771388888889);
    const wikiSearch = calls.find(
      (url) => url.searchParams.get("action") === "wbsearchentities",
    );
    assert.equal(wikiSearch?.searchParams.get("search"), "Нижнее");
    assert.equal(wikiSearch?.searchParams.get("limit"), "20");
  } finally {
    store.close();
    db.close();
  }
});

test("historical geocoding retries a Wikidata maxlag response", async () => {
  const db = new DatabaseSync(":memory:"),
    calls: URL[] = [];
  let searchCalls = 0;
  initializeArchiveSchema(db);
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === "photon.komoot.io")
      return Response.json({ features: [] });
    if (url.searchParams.get("action") === "wbsearchentities") {
      searchCalls++;
      if (searchCalls === 1)
        return Response.json(
          { error: { code: "maxlag", info: "replica is lagged" } },
          { headers: { "Retry-After": "0" } },
        );
      return Response.json(search);
    }
    return Response.json(entities);
  };
  const store = geocodingStore(db, fetcher, 0);
  try {
    const result = await store.locate("Старое имя");
    assert.equal(result.automatic?.name, "Современное имя");
    assert.equal(result.notice, undefined);
    assert.equal(searchCalls, 2);
    assert.equal(calls.length, 4);
  } finally {
    store.close();
    db.close();
  }
});

test("repeated Wikidata maxlag does not hold every queued Photon lookup", async () => {
  const db = new DatabaseSync(":memory:");
  let photonCalls = 0,
    wikiCalls = 0;
  initializeArchiveSchema(db);
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "photon.komoot.io") {
      photonCalls++;
      return Response.json({ features: [feature("Современное место")] });
    }
    wikiCalls++;
    return Response.json(
      { error: { code: "maxlag", info: "replica is lagged" } },
      { headers: { "Retry-After": "0" } },
    );
  };
  const store = geocodingStore(db, fetcher, 0);
  try {
    const first = await store.locate("Старое имя");
    const second = await store.locate("Другое старое имя");
    assert.ok(first.notice);
    assert.ok(second.notice);
    assert.equal(photonCalls, 2);
    assert.equal(wikiCalls, 2, "cooldown должен остановить повторный maxlag");
  } finally {
    store.close();
    db.close();
  }
});

test("historical directory failure keeps current candidates and manual correction available", async () => {
  const db = new DatabaseSync(":memory:"),
    calls: URL[] = [];
  initializeArchiveSchema(db);
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    return url.hostname === "photon.komoot.io"
      ? Response.json({ features: [feature("Современное место")] })
      : Response.json({ error: { code: "readonly" } });
  };
  const store = geocodingStore(db, fetcher, 0);
  try {
    const result = await store.locate("Старое имя");
    assert.equal(result.candidates.length, 1);
    assert.match(result.notice || "", /указать точку на карте/);
    assert.equal(calls.length, 2);
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS count FROM geocode_cache").get() as {
          count: number;
        }
      ).count,
      0,
      "частичный ответ не должен кэшироваться на 180 дней",
    );
  } finally {
    store.close();
    db.close();
  }
});
