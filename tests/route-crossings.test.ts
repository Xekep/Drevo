import test from "node:test";
import assert from "node:assert/strict";
import {
  crossingGeometryKey,
  crossingPaths,
  type CrossingEdge,
} from "../src/domain/route-crossings.ts";

const horizontal = (x = 50): CrossingEdge[] => [
  {
    id: "horizontal",
    group: "family-a",
    route: {
      sourceHandle: "right",
      targetHandle: "left",
      points: [
        { x: 0, y: 50 },
        { x: 100, y: 50 },
      ],
    },
  },
  {
    id: "vertical",
    group: "family-b",
    route: {
      sourceHandle: "bottom",
      targetHandle: "top",
      points: [
        { x, y: 0 },
        { x, y: 100 },
      ],
    },
  },
];

test("crossing geometry key depends only on ids, groups and route geometry", () => {
  const first = horizontal(),
    clone = structuredClone(first);
  assert.equal(crossingGeometryKey(first), crossingGeometryKey(clone));
  clone[1].route!.points[0].x = 60;
  clone[1].route!.points[1].x = 60;
  assert.notEqual(crossingGeometryKey(first), crossingGeometryKey(clone));
});

test("crossing paths reuse the previous calculation for identical geometry", () => {
  const first = crossingPaths(horizontal());
  assert.ok(first.get("horizontal"), "горизонтальная линия получает разрыв");

  const sameGeometry = crossingPaths(structuredClone(horizontal()));
  assert.equal(
    sameGeometry,
    first,
    "новые edge-объекты с прежними маршрутами используют тот же результат",
  );

  const changedGeometry = crossingPaths(horizontal(65));
  assert.notEqual(changedGeometry, first, "изменение маршрута инвалидирует кэш");
  assert.notEqual(
    changedGeometry.get("horizontal"),
    first.get("horizontal"),
    "разрыв пересчитывается в новой координате",
  );
});

test("branches from one group do not receive artificial crossing gaps", () => {
  const edges = horizontal();
  edges[1].group = edges[0].group;
  assert.equal(crossingPaths(edges).size, 0);
});
