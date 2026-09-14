import assert from "node:assert/strict";
import test from "node:test";
import type { LayoutPerson } from "../src/domain/tree-layout.ts";
import {
  TREE_GROWTH_EDGE_MS,
  TREE_GROWTH_MAX_DELAY_MS,
  TREE_GROWTH_NODE_MS,
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

test("tree growth follows birth dates and continues each ready family branch", () => {
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
  assert.equal(delays.edgeMs, TREE_GROWTH_EDGE_MS);

  const rootLine = cssMilliseconds(
    treeConnectionGrowthStyle(
      { from: "root", to: "older", type: "parent" },
      delays,
    )["--tree-growth-delay"],
  );
  assert.equal(rootLine, delays.get("root")! + delays.nodeMs);
  assert.equal(delays.get("older"), rootLine + delays.edgeMs);

  const parentGenerationReady =
    Math.max(
      delays.get("older")!,
      delays.get("spouse")!,
      delays.get("younger")!,
      delays.get("unknown")!,
    ) + delays.nodeMs;
  const grandchildLine = cssMilliseconds(
    treeConnectionGrowthStyle(
      { from: "older", to: "grandchild", type: "parent" },
      delays,
    )["--tree-growth-delay"],
  );
  assert.equal(grandchildLine, delays.get("spouse")! + delays.nodeMs);
  assert.ok(grandchildLine < parentGenerationReady);
  assert.equal(delays.get("grandchild"), grandchildLine + delays.edgeMs);
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
  assert.equal(delays.get("person-9999"), TREE_GROWTH_MAX_DELAY_MS);
  assert.ok(delays.nodeMs < TREE_GROWTH_NODE_MS);
  assert.ok(delays.edgeMs < TREE_GROWTH_EDGE_MS);
  assert.deepEqual(treeGrowthCanvasStyle(delays), {
    "--tree-growth-node-duration": `${Math.round(delays.nodeMs * 1_000) / 1_000}ms`,
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
  assert.equal(delays.nodeMs, TREE_GROWTH_NODE_MS);
  assert.equal(delays.edgeMs, TREE_GROWTH_EDGE_MS);
  for (const child of people.slice(1)) {
    const edgeStart = cssMilliseconds(
      treeConnectionGrowthStyle(
        { from: "root", to: child.id, type: "parent" },
        delays,
      )["--tree-growth-delay"],
    );
    assert.ok(edgeStart >= delays.get("root")! + delays.nodeMs);
    assert.ok(edgeStart + delays.edgeMs <= delays.get(child.id)! + 0.001);
  }
});
