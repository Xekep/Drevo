import test from "node:test";
import assert from "node:assert/strict";
import {
  biographyMapBlock,
  biographyMapRoute,
  parseBiographyMap,
  BIOGRAPHY_MAP_LIMIT,
  type BiographyMap,
} from "../src/domain/biography-map.ts";

const point = (lon: number, lat: number, name = "Точка") => ({
  type: "Feature" as const,
  properties: { name, date: "1943" },
  geometry: { type: "Point" as const, coordinates: [lon, lat] },
});
test("biography maps retain geographic order, captions, dates and imported paths", () => {
  const source = {
    type: "FeatureCollection",
    name: "Боевой путь",
    features: [
      point(30, 50),
      point(32, 52),
      {
        type: "Feature",
        properties: { name: "Исторический маршрут" },
        geometry: {
          type: "LineString",
          coordinates: [
            [10, 20],
            [11, 21],
          ],
        },
      },
    ],
  };
  const parsed = parseBiographyMap(JSON.stringify(source));
  assert.deepEqual(parsed, source);
  const snapshot = structuredClone(parsed);
  const connected = biographyMapRoute(parsed, true);
  assert.deepEqual(connected.features.at(-1)!.geometry, {
    type: "LineString",
    coordinates: [
      [30, 50],
      [32, 52],
    ],
  });
  assert.deepEqual(parsed, snapshot);
  assert.deepEqual(biographyMapRoute(connected, false), parsed);
  const reordered = biographyMapRoute(
    {
      ...connected,
      features: [
        connected.features[1],
        connected.features[0],
        ...connected.features.slice(2),
      ],
    },
    true,
  );
  assert.deepEqual(reordered.features.at(-1)!.geometry, {
    type: "LineString",
    coordinates: [
      [32, 52],
      [30, 50],
    ],
  });
  assert.equal(
    reordered.features.filter((f) => f.properties.drevoRoute).length,
    1,
  );
  assert.equal(reordered.features[2].properties.name, "Исторический маршрут");
  assert.deepEqual(
    parseBiographyMap(
      biographyMapBlock(connected).slice("```geojson\n".length, -4),
    ),
    connected,
  );
});

test("biography maps accept standard collections, polygons and individual geometry", () => {
  const geometry = {
    type: "GeometryCollection",
    geometries: [
      {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      {
        type: "MultiPoint",
        coordinates: [
          [1, 2],
          [2, 3],
        ],
      },
      {
        type: "MultiLineString",
        coordinates: [
          [
            [1, 2],
            [2, 3],
          ],
        ],
      },
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
    ],
  };
  assert.deepEqual(
    parseBiographyMap(JSON.stringify(geometry)).features[0].geometry,
    geometry,
  );
  assert.deepEqual(parseBiographyMap(JSON.stringify(point(30, 60))).features, [
    point(30, 60),
  ]);
  const annotated = {
    ...point(30, 60),
    id: "document-17",
    properties: {
      name: "Маркер",
      evidence: { reference: "Журнал 17", years: [1942, 1943] },
    },
  };
  assert.deepEqual(
    parseBiographyMap(JSON.stringify(annotated)).features[0],
    annotated,
  );
});

test("invalid, unbounded and remote map input cannot become a Leaflet layer", () => {
  for (const source of [
    "https://example.com/map.geojson",
    "null",
    "[]",
    "{}",
    JSON.stringify(point(181, 20)),
    JSON.stringify(point(20, -91)),
    '{"type":"Point","coordinates":[1e999,2]}',
    '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[2,2]]]}',
    '{"type":"LineString","coordinates":[[0,0]]}',
    JSON.stringify({
      type: "MultiPoint",
      coordinates: Array.from({ length: 2001 }, () => [0, 0]),
    }),
    " ".repeat(BIOGRAPHY_MAP_LIMIT + 1),
  ])
    assert.throws(() => parseBiographyMap(source));
  let nested: unknown = { type: "Point", coordinates: [0, 0] };
  for (let i = 0; i < 12; i++)
    nested = { type: "GeometryCollection", geometries: [nested] };
  assert.throws(() => parseBiographyMap(JSON.stringify(nested)));
});

test("a single point never invents a route and deleting a point removes obsolete route geometry", () => {
  const map: BiographyMap = {
    type: "FeatureCollection",
    features: [point(10, 20)],
  };
  assert.equal(biographyMapRoute(map, true).features.length, 1);
  const connected = biographyMapRoute(
    { ...map, features: [...map.features, point(20, 30)] },
    true,
  );
  assert.equal(
    biographyMapRoute(
      { ...connected, features: connected.features.slice(1) },
      true,
    ).features.length,
    1,
  );
});
