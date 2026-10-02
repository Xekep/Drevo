import test from "node:test";
import assert from "node:assert/strict";
import {
  routingContactScore,
  routingQuality,
  type RoutedGroup,
} from "../src/domain/routing-quality.ts";
import {
  branchContactCounts,
  createGeometryContactScorer,
  type UnionBranch,
} from "../src/domain/union-layout.ts";
import { segmentContact } from "../src/domain/edge-routing.ts";
import { segmentsCross, type Point } from "../src/domain/layout-order.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";

const edge = (group: string, coords: [number, number][]): RoutedGroup => ({
  group,
  route: {
    sourceHandle: "bottom",
    targetHandle: "top",
    points: coords.map(([x, y]) => ({ x, y })),
  },
});
const branches = (edges: RoutedGroup[]): UnionBranch[] =>
  edges.map((entry, index) => ({
    id: `branch-${index}`,
    source: `source-${index}`,
    target: `target-${index}`,
    union: entry.group,
    relations: [],
    route: entry.route,
  }));
const geometry = (edges: RoutedGroup[]): TreeGeometry => ({
  mode: "generations",
  reverse: false,
  positions: [],
  start: 0,
  offset: 0,
  branches: branches(edges),
});

/** Historical routingQuality semantics with a small all-pairs oracle, without Spatial. */
function legacyQuality(edges: RoutedGroup[]) {
  const lines: { a: Point; b: Point; group: string }[] = [];
  const ids = new Map<string, number>(),
    groups = new Map<string, number>();
  const contacts = new Set<string>(),
    crossings = new Set<string>();
  let length = 0,
    bends = 0;
  for (const entry of edges) {
    if (!ids.has(entry.group)) ids.set(entry.group, ids.size);
    let previous = "";
    for (let index = 1; index < entry.route.points.length; index++) {
      const a = entry.route.points[index - 1],
        b = entry.route.points[index];
      const size = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (!size) continue;
      length += size;
      const direction = a.x === b.x ? "v" : "h";
      if (previous && previous !== direction) bends++;
      previous = direction;
      for (const other of lines) {
        if (entry.group === other.group) continue;
        const contact = segmentContact(a, b, other.a, other.b);
        if (!contact) continue;
        const pair = [ids.get(entry.group)!, ids.get(other.group)!].sort(
          (a, b) => a - b,
        );
        const key = `${pair[0]}:${pair[1]}:${contact}`;
        if (!contacts.has(key)) {
          contacts.add(key);
          groups.set(entry.group, (groups.get(entry.group) || 0) + 1);
          groups.set(other.group, (groups.get(other.group) || 0) + 1);
        }
        if (segmentsCross([a, b], [other.a, other.b])) crossings.add(key);
      }
      lines.push({ a, b, group: entry.group });
    }
  }
  return {
    length,
    bends,
    contacts: contacts.size,
    crossings: crossings.size,
    groups,
  };
}

function compare(edges: RoutedGroup[]) {
  const before = structuredClone(edges);
  const score = routingContactScore(edges);
  assert.deepEqual(score.contacts, branchContactCounts(branches(edges)));
  assert.deepEqual(score.quality, legacyQuality(edges));
  assert.deepEqual(routingQuality(edges), score.quality);
  assert.deepEqual(
    edges,
    before,
    "scoring must not simplify or mutate input routes",
  );
  return score;
}

test("shared bus contributors preserve raw multiplicity while deduplicating family contacts", () => {
  const rail = edge("family", [
    [0, 50],
    [100, 50],
  ]);
  const score = compare([
    ...Array.from({ length: 5 }, () => structuredClone(rail)),
    edge("other", [
      [50, 0],
      [50, 100],
    ]),
    edge("third", [
      [75, 0],
      [75, 50],
    ]),
  ]);
  assert.deepEqual(score.contacts, { distinct: 2, segments: 10 });
  assert.equal(score.quality.crossings, 1);
  assert.equal(score.quality.length, 650);
  assert.equal(score.quality.bends, 0);
  assert.deepEqual(
    score.quality.groups,
    new Map([
      ["family", 2],
      ["other", 1],
      ["third", 1],
    ]),
  );
});

test("proper crossings, T joints, endpoint touches and collinear overlaps keep different costs", () => {
  const rail = edge("a", [
    [0, 0],
    [10, 0],
  ]);
  for (const [coords, raw, crossed, length] of [
    [
      [
        [5, -5],
        [5, 5],
      ],
      1,
      1,
      20,
    ],
    [
      [
        [5, -5],
        [5, 0],
      ],
      1,
      0,
      15,
    ],
    [
      [
        [10, 0],
        [10, 5],
      ],
      1,
      0,
      15,
    ],
    [
      [
        [5, -5],
        [5, 0],
        [5, 5],
      ],
      2,
      0,
      20,
    ],
    [
      [
        [2, 0],
        [8, 0],
      ],
      1,
      0,
      16,
    ],
    [
      [
        [10, 0],
        [15, 0],
      ],
      0,
      0,
      15,
    ],
  ] as [[number, number][], number, number, number][]) {
    const score = compare([rail, edge("b", coords)]);
    assert.deepEqual(score.contacts, { distinct: raw ? 1 : 0, segments: raw });
    assert.equal(score.quality.crossings, crossed);
    assert.equal(score.quality.length, length);
  }
});

test("numeric family IDs avoid delimiter collisions and identical IDs exclude internal contacts", () => {
  const score = compare([
    edge("a:b", [
      [-10, 0],
      [10, 0],
    ]),
    edge("c", [
      [0, -10],
      [0, 10],
    ]),
    edge("a", [
      [-10, 0],
      [10, 0],
    ]),
    edge("b:c", [
      [0, -10],
      [0, 10],
    ]),
    edge("a:b", [
      [-10, 0],
      [10, 0],
    ]),
    edge("雪:семья|0", [
      [0, 30],
      [10, 30],
    ]),
  ]);
  assert.deepEqual(score.contacts, { distinct: 6, segments: 9 });
  assert.equal(score.quality.crossings, 4);
  assert.equal(score.quality.groups.has("雪:семья|0"), false);
  assert.deepEqual(
    compare([
      edge("", [
        [0, 0],
        [10, 0],
      ]),
      edge("", [
        [5, -5],
        [5, 5],
      ]),
    ]).contacts,
    { distinct: 0, segments: 0 },
  );
});

test("fractional length accumulation and repeated turns retain strict legacy arithmetic", () => {
  const edges = [
    edge("turns", [
      [0, 0],
      [0, 0],
      [0.1, 0],
      [0.1, 0.2],
      [0.3, 0.2],
      [0.3, 0.2],
      [0.3, 0.5],
      [0.7, 0.5],
    ]),
    edge("long", [
      [0.1, 3],
      [10.1, 3],
      [10.1, 3],
    ]),
    edge("short", [
      [0, 6],
      [0, 6.1],
      [0.2, 6.1],
      [0.2, 6.5],
      [0.8, 6.5],
      [0.8, 6.5],
    ]),
    edge("empty", []),
    edge("point", [[4, 4]]),
  ];
  const score = compare(edges);
  assert.equal(score.quality.length, legacyQuality(edges).length);
  assert.equal(score.quality.bends, 7);
  assert.deepEqual(score.contacts, { distinct: 0, segments: 0 });
  // Summing the tiny group's routes separately before adding the long route
  // rounds differently from the historical left-to-right segment accumulation.
  const tiny = Array.from({ length: 5 }, (_, index) =>
    edge("tiny", [
      [0, index + 10],
      [2.5e-13, index + 10],
    ]),
  );
  const interleaved = compare([
    edge("long", [
      [0, 0],
      [10000, 0],
    ]),
    ...tiny,
  ]);
  assert.equal(interleaved.quality.length, 10000);
  assert.notEqual(
    10000 + tiny.reduce((sum) => sum + 2.5e-13, 0),
    interleaved.quality.length,
  );
});

test("geometry scorer preserves branch-only and extra-route semantics in either call order", () => {
  const edges = [
    edge("family", [
      [0, 50],
      [100, 50],
    ]),
    edge("other", [
      [50, 0],
      [50, 100],
    ]),
  ];
  const extra = [
    edge("adoption", [
      [75, 0],
      [75, 100],
    ]),
    edge("family", [
      [90, 0],
      [90, 100],
    ]),
  ];
  const base = geometry(edges);
  for (const current of [
    base,
    { ...base, routes: [] },
    {
      ...base,
      routes: extra.map((entry): [string, typeof entry.route] => [
        entry.group,
        entry.route,
      ]),
    },
  ]) {
    const before = structuredClone(current);
    const all = [
      ...edges,
      ...(current.routes || []).map(([group, route]) => ({ group, route })),
    ];
    for (const qualityFirst of [false, true]) {
      const scorer = createGeometryContactScorer();
      if (qualityFirst)
        assert.deepEqual(scorer.quality(current), legacyQuality(all));
      assert.deepEqual(
        scorer.contacts(current),
        branchContactCounts(current.branches!),
      );
      assert.deepEqual(scorer.quality(current), legacyQuality(all));
      assert.deepEqual(scorer.contacts(current), { distinct: 1, segments: 1 });
      assert.equal(
        scorer.quality(current).contacts,
        current.routes?.length ? 2 : 1,
      );
    }
    assert.deepEqual(current, before);
  }
  const empty = geometry([]),
    scorer = createGeometryContactScorer();
  assert.deepEqual(scorer.contacts(empty), { distinct: 0, segments: 0 });
  assert.deepEqual(scorer.quality(empty), legacyQuality([]));
});

test("deterministic orthogonal walks agree with both historical scores across duplicates and order changes", () => {
  let state = 20261002;
  const integer = () =>
    ((state = (state * 1664525 + 1013904223) >>> 0) % 41) - 20;
  const ids = ["", "семья:雪", "a:b", "a", "b:c", "c"];
  for (let sample = 0; sample < 32; sample++) {
    const edges = Array.from({ length: 10 }, (_, index) => {
      const coords: [number, number][] = [[integer(), integer()]];
      for (let step = 0; step < 6; step++) {
        const [x, y] = coords.at(-1)!;
        coords.push(step % 2 ? [x, integer()] : [integer(), y]);
      }
      return edge(ids[index % ids.length], coords);
    });
    edges.push(structuredClone(edges[0]));
    const forward = compare(edges),
      backward = compare([...edges].reverse());
    assert.deepEqual(backward.contacts, forward.contacts);
    assert.equal(backward.quality.length, forward.quality.length);
    assert.equal(backward.quality.bends, forward.quality.bends);
    assert.equal(backward.quality.crossings, forward.quality.crossings);
    assert.deepEqual(backward.quality.groups, forward.quality.groups);
  }
});
