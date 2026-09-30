import assert from "node:assert/strict";
import test from "node:test";
import type { LayoutPerson } from "../src/domain/tree-layout.ts";
import {
  TREE_GROWTH_EDGE_MS,
  treeGrowthBudget,
  treeGrowthDuration,
  TREE_GROWTH_NODE_MS,
  TREE_GROWTH_REVEAL_MS,
  treeConnectionGrowthStyle,
  treeGrowthCanvasStyle,
  treeGrowthDelays,
} from "../src/components/tree/tree-growth.ts";

function person(
  id: string,
  birth: string,
  parents: string[] = [],
  spouses: string[] = [],
): LayoutPerson {
  return { id, birth, parents, spouses };
}

function cssMilliseconds(value: string) {
  return Number.parseFloat(value);
}

test("the entire introduction gets a shorter budget as archives grow", () => {
  let previous = Infinity;
  for (const count of [25, 100, 200, 500, 2_000]) {
    const people = Array.from({ length: count }, (_, index) =>
      person(`p-${index}`, "1900", index ? [`p-${index - 1}`] : []),
    );
    const schedule = treeGrowthDelays(people);
    const duration = treeGrowthDuration(
      Math.max(...schedule.values()),
      schedule,
    );
    assert.ok(duration < previous);
    assert.ok(duration <= treeGrowthBudget(count) + 0.001);
    assert.ok(schedule.labelMs > 0);
    previous = duration;
  }
  assert.equal(treeGrowthBudget(100), 2_000);
  assert.equal(treeGrowthBudget(10_000), 600);
  assert.equal(treeGrowthDelays([]).size, 0);
});

test("tree growth follows birth dates and finishes a generation before its descendants", () => {
  const people = [
    person("root", "1940-01-01"),
    person("older", "1965-01-01", ["root"], ["spouse"]),
    person("spouse", "1967-01-01", [], ["older"]),
    person("younger", "1968-01-01", ["root"]),
    person("unknown", "", ["root"]),
    person("grandchild", "1990-01-01", ["older"]),
  ];
  const delays = treeGrowthDelays(people);

  assert.ok(delays.get("older")! < delays.get("spouse")!);
  assert.ok(delays.get("spouse")! < delays.get("younger")!);
  assert.ok(delays.get("younger")! < delays.get("unknown")!);
  assert.equal(delays.nodeMs, TREE_GROWTH_NODE_MS);
  assert.equal(delays.revealMs, TREE_GROWTH_REVEAL_MS);
  assert.equal(delays.edgeMs, TREE_GROWTH_EDGE_MS);

  const rootLine = cssMilliseconds(
    treeConnectionGrowthStyle(
      { from: "root", to: "older", type: "parent" },
      delays,
    )["--tree-growth-delay"],
  );
  assert.equal(rootLine, delays.get("root")! + delays.revealMs);
  assert.ok(
    rootLine < delays.get("root")! + delays.nodeMs,
    "outgoing arrows start while the card is still settling, with no idle phase",
  );
  assert.equal(delays.get("older"), rootLine + delays.edgeMs);

  const parentGenerationReady =
    Math.max(
      delays.get("older")!,
      delays.get("spouse")!,
      delays.get("younger")!,
      delays.get("unknown")!,
    ) + delays.revealMs;
  const grandchildLine = cssMilliseconds(
    treeConnectionGrowthStyle(
      { from: "older", to: "grandchild", type: "parent" },
      delays,
    )["--tree-growth-delay"],
  );
  assert.equal(grandchildLine, parentGenerationReady);
  assert.equal(delays.get("grandchild"), grandchildLine + delays.edgeMs);
});

test("independent branches share a generation-wide arrow phase", () => {
  const delays = treeGrowthDelays([
    person("root-a", "1900"),
    person("root-b", "1910"),
    person("child-a", "1930", ["root-a"]),
    person("child-b", "1940", ["root-b"]),
    person("grandchild", "1960", ["child-a"]),
  ]);
  const lineA = cssMilliseconds(
    treeConnectionGrowthStyle(
      { from: "root-a", to: "child-a", type: "parent" },
      delays,
    )["--tree-growth-delay"],
  );
  const lineB = cssMilliseconds(
    treeConnectionGrowthStyle(
      { from: "root-b", to: "child-b", type: "parent" },
      delays,
    )["--tree-growth-delay"],
  );
  assert.equal(lineA, lineB);
  assert.equal(lineA, delays.get("root-b")! + delays.revealMs);
  assert.equal(delays.get("child-a"), lineA + delays.edgeMs);
  assert.ok(delays.get("child-b")! >= delays.get("child-a")!);
  const grandchildLine = cssMilliseconds(
    treeConnectionGrowthStyle(
      { from: "child-a", to: "grandchild", type: "parent" },
      delays,
    )["--tree-growth-delay"],
  );
  assert.equal(grandchildLine, delays.get("child-b")! + delays.revealMs);
  assert.equal(delays.get("grandchild"), grandchildLine + delays.edgeMs);
});

test("birth-order stagger stretches incoming lines without an idle gap before any child", () => {
  const people = [
    person("root", "1900"),
    ...Array.from({ length: 12 }, (_, index) =>
      person(`child-${index}`, String(1920 + index), ["root"]),
    ),
  ];
  const delays = treeGrowthDelays(people);
  for (const child of people.slice(1)) {
    const style = treeConnectionGrowthStyle(
      { from: "root", to: child.id, type: "parent" },
      delays,
    );
    const start = cssMilliseconds(style["--tree-growth-delay"]);
    const duration = cssMilliseconds(style["--tree-growth-edge-duration"]!);
    assert.ok(Math.abs(start + duration - delays.get(child.id)!) < 0.002);
    assert.ok(
      Math.abs(
        cssMilliseconds(style["--tree-edge-label-delay"]!) -
          delays.get(child.id)!,
      ) < 0.002,
    );
    assert.equal(start, delays.revealMs);
  }
});

test("deep archives compress the whole schedule without reversing arrows and cards", () => {
  const people = Array.from({ length: 10_000 }, (_, index) =>
    person(
      `person-${index}`,
      String(1800 + Math.min(index, 199)),
      index ? [`person-${index - 1}`] : [],
    ),
  );
  const delays = treeGrowthDelays(people);
  assert.equal(delays.size, people.length);
  assert.ok(
    treeGrowthDuration(delays.get("person-9999")!, delays) <=
      treeGrowthBudget(people.length) + 0.001,
  );
  assert.ok(delays.nodeMs < TREE_GROWTH_NODE_MS);
  assert.ok(delays.edgeMs < TREE_GROWTH_EDGE_MS);
  assert.deepEqual(treeGrowthCanvasStyle(delays), {
    "--tree-growth-label-duration": `${Math.round(delays.labelMs * 1_000) / 1_000}ms`,
    "--tree-growth-node-duration": `${Math.round(delays.nodeMs * 1_000) / 1_000}ms`,
    "--tree-growth-reveal-duration": `${Math.round(delays.revealMs * 1_000) / 1_000}ms`,
    "--tree-growth-edge-duration": `${Math.round(delays.edgeMs * 1_000) / 1_000}ms`,
  });

  for (let index = 1; index < people.length; index++) {
    const child = `person-${index}`;
    const edgeStart = cssMilliseconds(
      treeConnectionGrowthStyle(
        {
          from: `person-${index - 1}`,
          to: child,
          type: "parent",
        },
        delays,
      )["--tree-growth-delay"],
    );
    assert.ok(
      edgeStart + delays.edgeMs <= delays.get(child)! + 0.001,
      `edge ${index - 1} must finish before ${child}`,
    );
  }
});

test("wide archives schedule every descendant without a fixed family size", () => {
  const people = [
    person("root", "1900-01-01"),
    ...Array.from({ length: 10_000 }, (_, index) =>
      person(
        `child-${index.toString().padStart(5, "0")}`,
        `${2000 + Math.floor(index / 366)}-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
        ["root"],
      ),
    ),
  ];
  const delays = treeGrowthDelays(people);

  assert.equal(delays.size, people.length);
  assert.ok(delays.nodeMs < TREE_GROWTH_NODE_MS);
  assert.ok(delays.edgeMs < TREE_GROWTH_EDGE_MS);
  for (const child of people.slice(1)) {
    const edgeStart = cssMilliseconds(
      treeConnectionGrowthStyle(
        { from: "root", to: child.id, type: "parent" },
        delays,
      )["--tree-growth-delay"],
    );
    assert.ok(edgeStart + 0.001 >= delays.get("root")! + delays.revealMs);
    assert.ok(edgeStart + delays.edgeMs <= delays.get(child.id)! + 0.001);
  }
});
